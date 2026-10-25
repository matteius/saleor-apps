import { MongoClient } from "mongodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MongoAPL } from "./mongodb-apl";

const { client, collection, db } = vi.hoisted(() => {
  const collection = { createIndex: vi.fn() };
  const db = { collection: vi.fn(), admin: vi.fn() };
  const client = { connect: vi.fn(), db: vi.fn(), close: vi.fn() };

  return { client, collection, db };
});

vi.mock("mongodb", () => ({
  MongoClient: vi.fn(function () {
    return client;
  }),
}));

vi.mock("../../env", () => ({
  env: { MONGODB_URL: "mongodb://localhost:27017/test", MONGODB_DATABASE: "saleor_smtp_test" },
}));

describe("MongoAPL connection lifecycle", () => {
  let apl: MongoAPL;

  beforeEach(() => {
    vi.mocked(MongoClient).mockImplementation(function () {
      return client;
    } as never);
    client.connect.mockReset().mockResolvedValue(undefined);
    client.db.mockReset().mockReturnValue(db);
    client.close.mockReset().mockResolvedValue(undefined);
    collection.createIndex.mockReset().mockResolvedValue("saleorApiUrl_1");
    db.collection.mockReset().mockReturnValue(collection);
    db.admin.mockReset().mockReturnValue({ ping: vi.fn().mockResolvedValue(undefined) });
    apl = new MongoAPL();
  });

  it("recovers after an initial MongoDB connection failure", async () => {
    client.connect.mockRejectedValueOnce(new Error("temporary outage"));

    expect((await apl.isReady()).ready).toBe(false);
    expect((await apl.isReady()).ready).toBe(true);
    expect(client.connect).toHaveBeenCalledTimes(2);
  });

  it("reopens MongoDB after close", async () => {
    expect((await apl.isReady()).ready).toBe(true);
    await apl.close();
    expect((await apl.isReady()).ready).toBe(true);
    expect(client.connect).toHaveBeenCalledTimes(2);
    expect(client.close).toHaveBeenCalledTimes(1);
  });
});
