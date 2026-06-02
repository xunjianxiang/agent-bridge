import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus
} from "@nestjs/common";
import type { FastifyReply } from "fastify";

export interface HttpErrorEnvelope {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details?: unknown;
  };
}

export function normalizeHttpError(error: unknown): HttpErrorEnvelope {
  if (error instanceof HttpException) {
    const status = error.getStatus();
    const response = error.getResponse();
    return {
      error: {
        code: statusCodeToErrorCode(status),
        message: responseMessage(response, status),
        retryable: status >= 500,
        ...responseDetails(response)
      }
    };
  }

  return {
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: error instanceof Error ? error.message : "Internal server error.",
      retryable: true
    }
  };
}

@Catch()
export class BridgeHttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<FastifyReply>();
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    void response.status(status).send(normalizeHttpError(exception));
  }
}

function statusCodeToErrorCode(status: number): string {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return "BAD_REQUEST";
    case HttpStatus.NOT_FOUND:
      return "NOT_FOUND";
    case HttpStatus.CONFLICT:
      return "CONFLICT";
    case HttpStatus.UNAUTHORIZED:
      return "UNAUTHORIZED";
    case HttpStatus.FORBIDDEN:
      return "FORBIDDEN";
    default:
      return status >= 500 ? "INTERNAL_SERVER_ERROR" : "HTTP_ERROR";
  }
}

function responseMessage(response: string | object, status: number): string {
  if (typeof response === "string") {
    return response;
  }

  const message = (response as { message?: unknown }).message;
  if (typeof message === "string") {
    return message;
  }
  if (Array.isArray(message)) {
    return message.join("; ");
  }

  if (status === HttpStatus.BAD_REQUEST) {
    return "Request validation failed.";
  }

  return "Request failed.";
}

function responseDetails(response: string | object): { details?: unknown } {
  if (typeof response === "string") {
    return {};
  }

  const details = { ...response };
  delete (details as { statusCode?: unknown }).statusCode;
  delete (details as { error?: unknown }).error;
  delete (details as { message?: unknown }).message;

  return Object.keys(details).length > 0 ? { details } : {};
}
