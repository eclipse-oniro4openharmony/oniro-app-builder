/*
 * Test fixture: a cut-down @ohos.router declaration file.
 */
/**
 * @file
 * @kit ArkUI
 */
import { AsyncCallback } from './@ohos.base';
/**
 * Router.
 *
 * @namespace router
 * @syscap SystemCapability.ArkUI.ArkUI.Full
 * @since 8
 */
declare namespace router {
    /**
     * Router options.
     *
     * @interface RouterOptions
     * @syscap SystemCapability.ArkUI.ArkUI.Full
     * @since 8
     */
    interface RouterOptions {
        /**
         * The URL of the page.
         *
         * @type { string }
         * @since 8
         */
        url: string;
    }
    /**
     * Navigates to a specified page in the application.
     *
     * @param { RouterOptions } options - Options.
     * @param { AsyncCallback<void> } callback - The callback.
     * @syscap SystemCapability.ArkUI.ArkUI.Full
     * @since 9
     * @deprecated since 18
     * @useinstead ohos.arkui.UIContext.Router#pushUrl
     */
    function pushUrl(options: RouterOptions, callback: AsyncCallback<void>): void;
    /**
     * Navigates to a specified page in the application.
     *
     * @param { RouterOptions } options - Options.
     * @returns { Promise<void> } the promise.
     * @syscap SystemCapability.ArkUI.ArkUI.Full
     * @since 9
     * @deprecated since 18
     * @useinstead ohos.arkui.UIContext.Router#pushUrl
     */
    function pushUrl(options: RouterOptions): Promise<void>;
    /**
     * Returns to the previous page.
     *
     * @syscap SystemCapability.ArkUI.ArkUI.Full
     * @since 8
     */
    function back(): void;
}
export default router;
