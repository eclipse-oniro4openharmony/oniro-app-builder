/*
 * Test fixture: a cut-down navigation component declaration file.
 */
/**
 * @file
 * @kit ArkUI
 */
/**
 * Indicates the information of NavDestinations.
 *
 * @syscap SystemCapability.ArkUI.ArkUI.Full
 * @crossplatform
 * @since 10
 */
/**
 * Indicates the information of NavDestinations. Providers methods for controlling destination page in the stack
 *
 * @syscap SystemCapability.ArkUI.ArkUI.Full
 * @crossplatform
 * @atomicservice
 * @since 11
 */
declare class NavPathStack {
    /**
     * Creates an instance of NavPathStack.
     *
     * @since 10
     */
    constructor();
    /**
     * Pushes the specified NavDestination into the stack.
     *
     * @param { string } name - Indicates the name of the NavDestination to be pushed.
     * @param { unknown } param - Indicates the detailed parameter of the NavDestination to be pushed.
     * @param { boolean } [animated] - Indicates whether the transition is animated.
     * @syscap SystemCapability.ArkUI.ArkUI.Full
     * @since 10
     */
    pushPathByName(name: string, param: unknown, animated?: boolean): void;
    /**
     * Pushes the specified NavDestination into the stack.
     *
     * @param { string } name - Indicates the name of the NavDestination to be pushed.
     * @param { Object } param - Indicates the detailed parameter of the NavDestination to be pushed.
     * @param { import('../api/@ohos.base').Callback<PopInfo> } onPop - The callback when the NavDestination pops.
     * @param { boolean } [animated] - Indicates whether the transition is animated.
     * @syscap SystemCapability.ArkUI.ArkUI.Full
     * @since 11
     */
    pushPathByName(name: string, param: Object, onPop: import('../api/@ohos.base').Callback<PopInfo>, animated?: boolean): void;
    /**
     * Pops the top NavDestination out of the stack.
     *
     * @returns { NavPathInfo | undefined } the top NavPathInfo.
     * @since 10
     */
    pop(): NavPathInfo | undefined;
}
