import { BadRequestException, NotFoundException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { normalizeHttpError } from "../src/core/http-error.js";

describe("normalizeHttpError", () => {
  it("returns one stable error envelope for Nest HTTP exceptions", () => {
    expect(normalizeHttpError(new BadRequestException("input is invalid"))).toEqual({
      error: {
        code: "BAD_REQUEST",
        message: "input is invalid",
        retryable: false
      }
    });
    expect(normalizeHttpError(new NotFoundException("run missing"))).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "run missing",
        retryable: false
      }
    });
  });

  it("keeps structured validation details in the stable envelope", () => {
    const exception = new BadRequestException({
      formErrors: [],
      fieldErrors: { provider: ["Invalid option"] }
    });

    expect(normalizeHttpError(exception)).toEqual({
      error: {
        code: "BAD_REQUEST",
        message: "Request validation failed.",
        retryable: false,
        details: {
          formErrors: [],
          fieldErrors: { provider: ["Invalid option"] }
        }
      }
    });
  });
});
