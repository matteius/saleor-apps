# OCR Credits Saleor App

A Saleor app that automatically provisions OCR page credits to the Demetered metering service when customers complete purchases.

## How It Works

1. Customer purchases OCR credits via the OpenSensor OCR channel
2. When the order is fully paid, Saleor sends an `ORDER_FULLY_PAID` webhook
3. This app extracts the product SKU and customer email from the order
4. It calls the Demetered API to add credits to the customer's account

## Supported Products

| SKU | Pages | Price |
|-----|-------|-------|
| OCR-2000 | 2,000 | $20 |
| OCR-5000 | 5,000 | $45 |
| OCR-10000 | 10,000 | $80 |
| OCR-25000 | 25,000 | $175 |

## Configuration

Copy `.env.example` to `.env.local` and configure:

- `DEMETERED_API_URL` - Demetered API endpoint
- `DEMETERED_ADMIN_API_KEY` - Admin API key with scope to add credits

## Development

```bash
pnpm install
pnpm dev
```

## Deployment

Install the app in your Saleor Dashboard and configure the webhook endpoint.

