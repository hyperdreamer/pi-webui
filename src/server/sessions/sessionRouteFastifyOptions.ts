import { SESSION_REORDER_SESSION_ID_MAX_LENGTH } from "../../shared/apiTypes.js";

/** Router capacity required for strict validation of the reorder session ID. */
export const sessionRouteFastifyOptions = {
  routerOptions: {
    maxParamLength: SESSION_REORDER_SESSION_ID_MAX_LENGTH + 1,
  },
};
