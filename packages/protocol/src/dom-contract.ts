// The DOM contract (A§19): names the product publishes and e2e/lib and the QA prelude read.

/** `<meta name="moss-build" content="<commit>:<bundleHash>">`, rendered by the Worker's SSR. */
export const BUILD_META = 'moss-build';

/** `html[data-client-build="<commit>:<clientHash>"]`, stamped by the client entry before React mounts. */
export const CLIENT_BUILD_ATTR = 'data-client-build';
