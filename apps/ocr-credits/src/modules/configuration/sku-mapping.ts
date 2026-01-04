/**
 * Maps Saleor product variant SKUs to the number of OCR pages they provide.
 * 
 * These SKUs must match the product variants configured in Saleor for the
 * opensensor-ocr channel.
 */
export const SKU_TO_PAGES: Record<string, number> = {
  "OCR-500": 500,
  "OCR-1000": 1000,
  "OCR-2000": 2000,
  "OCR-5000": 5000,
  "OCR-10000": 10000,
  "OCR-25000": 25000,
};

/**
 * Get the number of pages for a given SKU.
 * Returns 0 if the SKU is not recognized.
 */
export function getPagesForSku(sku: string | null | undefined): number {
  if (!sku) return 0;

  return SKU_TO_PAGES[sku] ?? 0;
}

/**
 * Check if a SKU is an OCR credits product.
 */
export function isOcrCreditsSku(sku: string | null | undefined): boolean {
  if (!sku) return false;

  return sku in SKU_TO_PAGES;
}

