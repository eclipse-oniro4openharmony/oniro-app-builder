/*
 * The permission list below is data from openharmony-sig/deveco-cli
 * (`src/resources/aclPermission/aclPermissionsInfo.json`), Copyright (c) 2026
 * Huawei Device Co., Ltd., licensed under the MIT License.
 * See packages/core/src/harmonyos/NOTICE.md.
 */

/**
 * HarmonyOS permissions that are ACL-gated: an app requesting one needs it listed
 * in its provisioning profile, or installation is refused on-device.
 */
export const ACL_PERMISSIONS: ReadonlySet<string> = new Set([
  'ohos.permission.ACCESS_DDK_HID',
  'ohos.permission.ACCESS_DDK_SCSI_PERIPHERAL',
  'ohos.permission.ACCESS_DDK_USB',
  'ohos.permission.ACCESS_DDK_USB_SERIAL',
  'ohos.permission.ACCESS_DISK_PHY_INFO',
  'ohos.permission.ACCESS_FIDO2_ONLINEAUTH',
  'ohos.permission.ACCESS_NET_TRACE_INFO',
  'ohos.permission.ACCESS_USER_FULL_DISK',
  'ohos.permission.ACCESS_VIRTUAL_SCREEN',
  'ohos.permission.CUSTOMIZE_SAVE_BUTTON',
  'ohos.permission.CUSTOM_SCREEN_RECORDING',
  'ohos.permission.DLP_GET_HIDE_STATUS',
  'ohos.permission.FILE_ACCESS_PERSIST',
  'ohos.permission.GET_ABILITY_INFO',
  'ohos.permission.GET_ETHERNET_LOCAL_MAC',
  'ohos.permission.GET_IP_MAC_INFO',
  'ohos.permission.GET_WIFI_LOCAL_MAC',
  'ohos.permission.GET_WIFI_PEERS_MAC',
  'ohos.permission.HOOK_KEY_EVENT',
  'ohos.permission.INPUT_MONITORING',
  'ohos.permission.INTERCEPT_INPUT_EVENT',
  'ohos.permission.KEEP_BACKGROUND_RUNNING_SYSTEM',
  'ohos.permission.LINKTURBO',
  'ohos.permission.MANAGE_APN_SETTING',
  'ohos.permission.MANAGE_PASTEBOARD_APP_SHARE_OPTION',
  'ohos.permission.MANAGE_SCREEN_TIME_GUARD',
  'ohos.permission.MANAGE_UDMF_APP_SHARE_OPTION',
  'ohos.permission.PERSISTENT_BLUETOOTH_PEERS_MAC',
  'ohos.permission.PERSONAL_MANAGE_RESTRICTIONS',
  'ohos.permission.PRELOAD_FILE',
  'ohos.permission.READ_AUDIO',
  'ohos.permission.READ_CONTACTS',
  'ohos.permission.READ_IMAGEVIDEO',
  'ohos.permission.READ_LOCAL_DEVICE_NAME',
  'ohos.permission.READ_PASTEBOARD',
  'ohos.permission.READ_WRITE_DESKTOP_DIRECTORY',
  'ohos.permission.READ_WRITE_DOCUMENTS_DIRECTORY',
  'ohos.permission.READ_WRITE_DOWNLOAD_DIRECTORY',
  'ohos.permission.READ_WRITE_USB_DEV',
  'ohos.permission.READ_WRITE_USER_FILE',
  'ohos.permission.SET_PAC_URL',
  'ohos.permission.SET_SYSTEMSHARE_APPLAUNCHTRUSTLIST',
  'ohos.permission.SHORT_TERM_WRITE_IMAGEVIDEO',
  'ohos.permission.START_PROVISIONING_MESSAGE',
  'ohos.permission.SUBSCRIBE_NOTIFICATION',
  'ohos.permission.SYSTEM_FLOAT_WINDOW',
  'ohos.permission.USE_FLOAT_BALL',
  'ohos.permission.USE_FRAUD_APP_PICKER',
  'ohos.permission.USE_FRAUD_CALL_LOG_PICKER',
  'ohos.permission.USE_FRAUD_MESSAGES_PICKER',
  'ohos.permission.WEB_NATIVE_MESSAGING',
  'ohos.permission.WRITE_AUDIO',
  'ohos.permission.WRITE_CONTACTS',
  'ohos.permission.WRITE_IMAGEVIDEO',
  'ohos.permission.atomicService.MANAGE_STORAGE',
  'ohos.permission.kernel.ALLOW_EXECUTABLE_FORT_MEMORY',
  'ohos.permission.kernel.ALLOW_WRITABLE_CODE_MEMORY',
  'ohos.permission.kernel.DISABLE_CODE_MEMORY_PROTECTION',
  'ohos.permission.kernel.DISABLE_GOTPLT_RO_PROTECTION',
]);

