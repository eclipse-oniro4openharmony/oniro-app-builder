/*
 * Portions of this file are adapted from openharmony-sig/deveco-cli
 * (`src/signature/cert-api.ts`, `src/signature/device-manager.ts`,
 * `src/signature/generate-profile.ts`, `src/signature/download.ts`),
 * Copyright (c) 2026 Huawei Device Co., Ltd., licensed under the MIT License.
 * See packages/core/src/harmonyos/NOTICE.md.
 *
 * These are private, undocumented AppGallery Connect endpoints.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ChecksumMismatchError } from '../../ports/errors.js';
import type { AgcAuthInfo } from '../auth/types.js';
import type { HarmonyOsHttpClient, HttpRequestOptions } from '../http.js';
import { mapAgcError, readRet, type AgcOperation } from './errors.js';

const ENDPOINTS = {
  CERT_LIST: '/api/cps/harmony-cert-manage/v1/cert/list',
  CERT_ADD: '/api/cps/harmony-cert-manage/v1/cert/add',
  CERT_DELETE: '/api/cps/harmony-cert-manage/v1/cert/delete',
  /** Exchanges an object id for a short-lived signed download URL. */
  OBJECT_URL: '/api/amis/app-manage/v1/objects/url/reapply',
  DEVICE_LIST: '/api/cps/device-manage/v1/device/list',
  DEVICE_ADD: '/api/cps/device-manage/v1/device/add',
  /** Debug ("test") provisioning profiles — the only kind oniro-app issues. */
  PROVISION_ADD: '/api/cps/provision-manage/v1/ide/test/provision/add',
  PROVISION_DELETE: '/api/cps/provision-manage/v1/provision/delete',
} as const;

/** AGC device-type codes, by the device kind `hdc` reports. */
const DEVICE_TYPE_CODES: Record<string, number> = { liteWearable: 1, wearable: 2, tv: 3, phone: 4 };

export interface AgcCertificate {
  id: string;
  certName: string;
  /** Object-store handle, exchanged for a download URL. */
  certObjectId: string;
}

export interface AgcDevice {
  id: string;
  udid: string;
}

export type AgcClient = ReturnType<typeof createAgcClient>;

/** The AppGallery Connect signing endpoints, bound to one account and team. */
export function createAgcClient(http: HarmonyOsHttpClient, auth: AgcAuthInfo) {
  /** Call an endpoint and return its body; any failure form becomes an AgcError. */
  async function call<T>(
    operation: AgcOperation,
    method: 'get' | 'post' | 'delete',
    endpoint: string,
    opts: Omit<HttpRequestOptions, 'headers'> = {},
  ): Promise<T> {
    const response = await http[method](`${auth.baseUrl}${endpoint}`, {
      ...opts,
      headers: { uid: auth.uid, teamId: auth.teamId, oauth2Token: auth.accessToken },
    });
    if (response.statusCode !== 200 || readRet(response.data)?.code !== 0) {
      throw mapAgcError(operation, response.statusCode, response.statusText, response.data);
    }
    return JSON.parse(response.data) as T;
  }

  return {
    async listCertificates(): Promise<AgcCertificate[]> {
      return (await call<{ certList?: AgcCertificate[] }>('cert', 'post', ENDPOINTS.CERT_LIST)).certList ?? [];
    },

    async addCertificate(certName: string, csr: string): Promise<void> {
      // certType 1 is a debug certificate.
      await call('cert', 'post', ENDPOINTS.CERT_ADD, { body: { csr, certName, certType: '1' } });
    },

    async deleteCertificate(certId: string): Promise<void> {
      await call('cert', 'delete', ENDPOINTS.CERT_DELETE, { body: { certIds: [certId] } });
    },

    /** Every device registered to the team, across pages. */
    async listDevices(): Promise<AgcDevice[]> {
      const pageSize = 100;
      const devices: AgcDevice[] = [];
      for (let start = 1; ; start++) {
        const page = await call<{ list?: AgcDevice[]; totalCount?: number }>('device', 'get', ENDPOINTS.DEVICE_LIST, {
          query: { encodeFlag: 0, start, pageSize },
        });
        devices.push(...(page.list ?? []));
        if (!page.list?.length || devices.length >= (page.totalCount ?? 0)) return devices;
      }
    },

    async addDevice(udid: string, deviceKind: string): Promise<void> {
      // AGC rejects duplicate device names, so the name is made unique.
      const deviceName = `oniro_app_device_${crypto.randomBytes(4).toString('hex')}`;
      await call('device', 'post', ENDPOINTS.DEVICE_ADD, {
        body: { deviceName, udid, deviceType: String(DEVICE_TYPE_CODES[deviceKind] ?? DEVICE_TYPE_CODES.phone) },
      });
    },

    /** Issue a debug profile; returns its id and object handle. */
    async addDebugProfile(opts: {
      provisionName: string;
      bundleName: string;
      certId: string;
      deviceIds: string[];
      aclPermissions: string[];
    }): Promise<{ id: string; provisionFileUrl: string }> {
      return call('profile', 'post', ENDPOINTS.PROVISION_ADD, {
        body: {
          provisionName: opts.provisionName,
          packageName: opts.bundleName,
          certList: [opts.certId],
          deviceList: opts.deviceIds,
          ...(opts.aclPermissions.length ? { aclPermissionList: opts.aclPermissions } : {}),
        },
      });
    },

    async deleteProfile(id: string): Promise<void> {
      await call('profile', 'delete', ENDPOINTS.PROVISION_DELETE, { query: { id } });
    },

    /**
     * Download a certificate or profile object to `dest`, checking the digest AGC
     * supplies with the URL. Nothing is written unless it matches.
     */
    async download(operation: AgcOperation, objectId: string, dest: string): Promise<void> {
      const { urlsInfo } = await call<{ urlsInfo?: Array<{ newUrl: string; sha256: string }> }>(
        operation,
        'post',
        ENDPOINTS.OBJECT_URL,
        { body: { sourceUrls: objectId } },
      );
      const target = urlsInfo?.[0];
      if (!target) throw mapAgcError(operation, 200, '', '');

      const buffer = await http.getBinary(target.newUrl, { timeoutMs: 60_000 });
      const actual = crypto.createHash('sha256').update(buffer).digest('hex');
      if (target.sha256 && actual !== target.sha256.toLowerCase()) {
        throw new ChecksumMismatchError(target.sha256, actual);
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      fs.writeFileSync(dest, buffer, { mode: 0o600 });
    },
  };
}
