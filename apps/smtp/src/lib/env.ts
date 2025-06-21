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

  return typeof mongoUrl === "string" && mongoUrl.length > 0;
}
