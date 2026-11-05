/*
 * Test fixture: an ArkUI advanced component declared as a struct in a .d.ets file.
 */
/**
 * @file
 * @kit ArkUI
 */
/**
 * Declare Component DemoBar.
 *
 * @syscap SystemCapability.ArkUI.ArkUI.Full
 * @since 10
 */
@Component
export declare struct DemoBar {
    /**
     * The title.
     *
     * @type { ResourceStr }
     * @since 10
     */
    @Prop
    title: ResourceStr;
    /**
     * Builds the component.
     *
     * @since 10
     */
    build(): void;
}
