#ifndef SRC_NODE_API_H_
#define SRC_NODE_API_H_

#include "js_native_api_types.h"

#define NAPI_MODULE_VERSION 1

#if NAPI_VERSION >= 4

// Calling into JS from other threads
NAPI_EXTERN napi_status
napi_create_threadsafe_function(napi_env env,
                                napi_value func,
                                napi_threadsafe_function* result);

#endif  // NAPI_VERSION >= 4

#endif  // SRC_NODE_API_H_
