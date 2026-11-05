/*
 * Test fixture: ArkUI decorators.
 */
/**
 * @file
 * @kit ArkUI
 */
/**
 * Defines the options of Component ClassDecorator.
 *
 * @interface ComponentOptions
 * @since 11
 */
declare interface ComponentOptions {
    /**
     * Freeze the component when inactive.
     *
     * @type { boolean }
     * @since 11
     */
    freezeWhenInactive: boolean;
}
/**
 * Defining ComponentV2 ClassDecorator
 *
 * @syscap SystemCapability.ArkUI.ArkUI.Full
 * @crossplatform
 * @since 12
 */
declare const ComponentV2: ClassDecorator & ((options: ComponentOptions) => ClassDecorator);
/**
 * Defining Local PropertyDecorator.
 *
 * @syscap SystemCapability.ArkUI.ArkUI.Full
 * @crossplatform
 * @atomicservice
 * @since 12
 */
declare const Local: PropertyDecorator;
/**
 * Defining Provider PropertyDecorator.
 *
 * @since 12
 */
declare const Provider: (aliasName?: string) => PropertyDecorator;
/**
 * A dynamic API with a static counterpart.
 *
 * @since 12 dynamic
 * @since 23 static
 */
declare function localFunction(): void;
