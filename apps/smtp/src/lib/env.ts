// Simple environment variable validation for SMTP app
export const env = {
  get MONGODB_URL() {
    return process.env.MONGODB_URL;
  },
  get MONGODB_DATABASE() {
    return process.env.MONGODB_DATABASE;
  },
  get APL() {
    return process.env.APL;
  },
};

// Helper function to check if MongoDB is configured
export function isMongoDBConfigured(): boolean {
  const mongoUrl = env.MONGODB_URL;

  // Debug logging - only in development
  if (process.env.NODE_ENV === "development") {
    // eslint-disable-next-line no-console
    console.log("MongoDB APL Configuration Check:");
    // eslint-disable-next-line no-console
    console.log("MONGODB_URL:", mongoUrl ? "[SET]" : "[NOT SET]");
    // eslint-disable-next-line no-console
    console.log("MONGODB_URL type:", typeof mongoUrl);
    // eslint-disable-next-line no-console
    console.log("MONGODB_URL length:", mongoUrl?.length || 0);
  }

  return typeof mongoUrl === "string" && mongoUrl.length > 0;
}
