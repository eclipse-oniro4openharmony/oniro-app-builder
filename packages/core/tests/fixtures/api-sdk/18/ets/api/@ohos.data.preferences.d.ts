/*
 * Test fixture: a cut-down @ohos.data.preferences declaration file.
 */
/**
 * @file
 * @kit ArkData
 */
import Context from './application/BaseContext';
/**
 * Provides interfaces to obtain and modify preferences data.
 *
 * @namespace preferences
 * @syscap SystemCapability.DistributedDataManager.Preferences.Core
 * @since 9
 */
declare namespace preferences {
    /**
     * Indicates the possible types of preferences values.
     *
     * @since 9
     */
    type ValueType = number | string | boolean;
    /**
     * Obtains a Preferences instance matching a specified preferences file name.
     *
     * @param { Context } context - Indicates the context of application or capability.
     * @param { string } name - Indicates the preferences file name.
     * @returns { Promise<Preferences> } A Preferences instance.
     * @syscap SystemCapability.DistributedDataManager.Preferences.Core
     * @since 9
     */
    function getPreferences(context: Context, name: string): Promise<Preferences>;
    /**
     * Removes a Preferences instance from the cache, for system apps only.
     *
     * @param { string } name - Indicates the preferences file name.
     * @syscap SystemCapability.DistributedDataManager.Preferences.Core
     * @systemapi
     * @since 10
     */
    function removePreferencesFromCacheSync(name: string): void;
    /**
     * Provides interfaces to obtain and modify preferences data.
     *
     * @interface Preferences
     * @syscap SystemCapability.DistributedDataManager.Preferences.Core
     * @since 9
     */
    interface Preferences {
        /**
         * Obtains the value of a preferences instance.
         *
         * @param { string } key - Indicates the key of the preferences.
         * @param { ValueType } defValue - Indicates the default value.
         * @returns { Promise<ValueType> } The value.
         */
        get(key: string, defValue: ValueType): Promise<ValueType>;
    }
}
export default preferences;
