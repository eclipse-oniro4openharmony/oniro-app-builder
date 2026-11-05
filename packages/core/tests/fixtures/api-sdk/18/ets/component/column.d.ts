/*
 * Test fixture: a built-in component declared as `declare const X: XInterface`.
 */
/**
 * @file
 * @kit ArkUI
 */
/**
 * Defines the options of Column.
 *
 * @interface ColumnOptions
 * @since 7
 */
declare interface ColumnOptions {
    /**
     * Vertical space between children.
     *
     * @type { ?(string | number) }
     * @since 7
     */
    space?: string | number;
}
/**
 * Defines the Column Component.
 *
 * @interface ColumnInterface
 * @syscap SystemCapability.ArkUI.ArkUI.Full
 * @since 7
 */
interface ColumnInterface {
    /**
     * Defines the constructor of Column.
     *
     * @param { ColumnOptions } options - Column options.
     * @returns { ColumnAttribute } the attribute of the column.
     * @since 7
     */
    (options?: ColumnOptions): ColumnAttribute;
}
/**
 * Defines the Column attribute functions.
 *
 * @since 7
 */
declare class ColumnAttribute {
    /**
     * Sets the horizontal alignment.
     *
     * @param { HorizontalAlign } value - The alignment.
     * @returns { ColumnAttribute } the attribute of the column.
     * @since 7
     */
    alignItems(value: HorizontalAlign): ColumnAttribute;
}
/**
 * The main axis direction.
 *
 * @enum { number }
 * @since 7
 */
declare enum FlexDirection {
    /**
     * The main axis is consistent with the column direction.
     *
     * @since 7
     */
    Column = 2
}
/**
 * Defines Column Component.
 *
 * @syscap SystemCapability.ArkUI.ArkUI.Full
 * @since 7
 */
declare const Column: ColumnInterface;
/**
 * Defines Column Component instance.
 *
 * @since 7
 */
declare const ColumnInstance: ColumnAttribute;
