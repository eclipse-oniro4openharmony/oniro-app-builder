/*
 * Test fixture: the API 23 navigation declarations, with members API 18 lacks.
 */
/**
 * @file
 * @kit ArkUI
 */
/**
 * Indicates the information of NavDestinations.
 *
 * @syscap SystemCapability.ArkUI.ArkUI.Full
 * @since 10
 */
declare class NavPathStack {
    /**
     * Pushes the specified NavDestination into the stack.
     *
     * @param { string } name - Indicates the name of the NavDestination to be pushed.
     * @param { unknown } param - Indicates the detailed parameter of the NavDestination to be pushed.
     * @param { boolean } [animated] - Indicates whether the transition is animated.
     * @since 10
     */
    pushPathByName(name: string, param: unknown, animated?: boolean): void;
    /**
     * Get the NavPathInfo array.
     *
     * @returns { Array<NavPathInfo> } the NavPathInfo array.
     * @syscap SystemCapability.ArkUI.ArkUI.Full
     * @since 19
     */
    getPathStack(): Array<NavPathInfo>;
    /**
     * Clears the stack.
     *
     * @syscap SystemCapability.ArkUI.ArkUI.Full
     * @systemapi
     * @since 12
     */
    /**
     * Clears the stack.
     *
     * @syscap SystemCapability.ArkUI.ArkUI.Full
     * @atomicservice
     * @since 23
     */
    clearAll(): void;
}
