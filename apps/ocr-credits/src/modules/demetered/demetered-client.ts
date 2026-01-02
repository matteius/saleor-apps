import { err, ok, Result } from "neverthrow";

import { BaseError } from "@/errors";
import { createLogger } from "@/logger";

const logger = createLogger("DemeteredClient");

export interface CreditTopUpRequest {
  accountId: string;
  pages: number;
  orderId: string;
  source?: string;
}

export interface CreditTopUpResponse {
  account_id: string;
  pages_added: number;
  new_credit_balance: number;
  order_id: string | null;
  message: string;
}

export class DemeteredClient {
  static DemeteredClientError = BaseError.subclass("DemeteredClientError");
  static DemeteredClientNetworkError = BaseError.subclass("DemeteredClientNetworkError");

  private readonly config: {
    apiUrl: string;
    apiKey: string;
  };

  constructor(config: { apiUrl: string; apiKey: string }) {
    this.config = config;
  }

  async addCredits(
    request: CreditTopUpRequest,
  ): Promise<Result<CreditTopUpResponse, InstanceType<typeof DemeteredClient.DemeteredClientError>>> {
    const url = `${this.config.apiUrl}/v1/accounts/${encodeURIComponent(request.accountId)}/credits`;

    logger.info("Adding credits to Demetered account", {
      accountId: request.accountId,
      pages: request.pages,
      orderId: request.orderId,
    });

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          pages: request.pages,
          order_id: request.orderId,
          source: request.source || "saleor",
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();

        logger.error("Demetered API error", {
          status: response.status,
          error: errorText,
        });

        return err(
          new DemeteredClient.DemeteredClientError(`Demetered API error: ${response.status} - ${errorText}`),
        );
      }

      const data = (await response.json()) as CreditTopUpResponse;

      logger.info("Successfully added credits", {
        accountId: request.accountId,
        pagesAdded: data.pages_added,
        newBalance: data.new_credit_balance,
      });

      return ok(data);
    } catch (error) {
      logger.error("Failed to call Demetered API", { errorMessage: String(error) });

      return err(
        new DemeteredClient.DemeteredClientNetworkError("Failed to call Demetered API", {
          cause: error,
        }),
      );
    }
  }
}

