/*
 * Test fixture: a cut-down napi/native_api.h.
 */

/**
 * @addtogroup ArkTS_Napi_NativeModule
 * @{
 *
 * @brief Provides native api of ArkTS native module.
 *
 * @since 10
 */

/**
 * @file native_api.h
 *
 * @brief Defines native api of ArkTS native module.
 *
 * @kit ArkTS
 * @library libace_napi.z.so
 * @syscap SystemCapability.ArkUI.ArkUI.Napi
 * @since 10
 * @version 1.0
 */

#ifndef FOUNDATION_ACE_NAPI_INTERFACES_KITS_NAPI_NATIVE_API_H
#define FOUNDATION_ACE_NAPI_INTERFACES_KITS_NAPI_NATIVE_API_H

#ifndef NAPI_VERSION
#define NAPI_VERSION 8
#endif // NAPI_VERSION

#include "node_api.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * @brief Creates a thread-safe function.
 *
 * @param env Current running virtual machine context.
 * @param result The created thread-safe function.
 * @return Returns the function execution status.
 * @since 10
 */
NAPI_EXTERN napi_status napi_create_threadsafe_function(napi_env env,
                                                        napi_value func,
                                                        napi_threadsafe_function* result);

/**
 * @brief Runs an event loop.
 *
 * @param env Current running virtual machine context.
 * @param mode Indicates the running mode of the native event loop.
 * @return Returns the function execution status.
 * @since 12
 */
NAPI_EXTERN napi_status napi_run_event_loop(napi_env env, napi_event_mode mode);

/**
 * @brief Indicates the running mode of the native event loop.
 *
 * @since 12
 */
typedef enum {
    /** In this mode, the current asynchronous thread will be blocked. */
    napi_event_mode_default = 0,
    /** In this mode, the current asynchronous thread will not be blocked. */
    napi_event_mode_nowait = 1,
} napi_event_mode;

#ifdef __cplusplus
}
#endif

#endif /* FOUNDATION_ACE_NAPI_INTERFACES_KITS_NAPI_NATIVE_API_H */
