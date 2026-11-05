#ifndef SRC_JS_NATIVE_API_TYPES_H_
#define SRC_JS_NATIVE_API_TYPES_H_

#include <stddef.h>

typedef struct napi_env__* napi_env;
typedef struct napi_value__* napi_value;

typedef enum {
  // ES6 types (corresponds to typeof)
  napi_undefined,
  napi_null,
#if NAPI_VERSION >= 6
  napi_bigint,
#endif
} napi_valuetype;

typedef napi_value (*napi_callback)(napi_env env,
                                    napi_callback_info info);

typedef struct {
  const char* utf8name;
  napi_callback method;
  void (*finalize)(void* data);
} napi_property_descriptor;

#endif  // SRC_JS_NATIVE_API_TYPES_H_
