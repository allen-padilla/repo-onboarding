import { z } from "zod";

/**
 * A key, token, or name sent in an HTTP header or request: printable
 * characters with no spaces, so it cannot break the header or request it is
 * sent in.
 */
export const printableToken = z
  .string()
  .regex(/^[\x21-\x7e]+$/, { message: "must contain no spaces or control characters" });
