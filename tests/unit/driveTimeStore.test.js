/**
 * The 30-day drive-time store behind distanceMatrixService: pairs found in the
 * database aren't paid for again, and fresh results are written back.
 */
jest.mock("axios");
jest.mock("../../src/utils/logger-advanced", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock("../../src/utils/db", () => ({ isDbReady: jest.fn(() => true) }));
jest.mock("../../src/models/driveTimeModel", () => ({
  find: jest.fn(),
  bulkWrite: jest.fn(async () => ({})),
}));

const axios = require("axios");
const DriveTime = require("../../src/models/driveTimeModel");
const { isDbReady } = require("../../src/utils/db");
const { getDrivingMatrix, clearCache } = require("../../src/services/distanceMatrixService");

const A = { lat: 53.0168, lng: -2.2191 };
const B = { lat: 53.03, lng: -2.22 };
const C = { lat: 53.06, lng: -2.25 };
const key = (o, d) => `${o.lat.toFixed(4)},${o.lng.toFixed(4)}|${d.lat.toFixed(4)},${d.lng.toFixed(4)}`;
const el = (o, d, s) => ({ originIndex: o, destinationIndex: d, duration: `${s}s`, condition: "ROUTE_EXISTS" });
const found = (docs) => ({ lean: async () => docs });

beforeEach(() => {
  jest.clearAllMocks();
  clearCache();
  isDbReady.mockReturnValue(true);
  process.env.GOOGLE_MAPS_API_KEY = "test-key";
});

it("uses stored drive times and only asks Google for the rest", async () => {
  DriveTime.find.mockReturnValue(found([{ _id: key(A, B), minutes: 7 }]));
  axios.post.mockResolvedValue({ data: [el(0, 0, 600)] });

  const m = await getDrivingMatrix([A], [B, C], new Date(Date.now() + 5 * 24 * 3600 * 1000));

  expect(m).toEqual([[7, 10]]);
  expect(DriveTime.find).toHaveBeenCalledWith({ _id: { $in: [key(A, B), key(A, C)] } });
  const body = axios.post.mock.calls[0][1];
  expect(body.destinations).toHaveLength(1);
  expect(body.routingPreference).toBeUndefined(); // 5 days ahead: no traffic
});

it("writes fresh results back for 30 days", async () => {
  DriveTime.find.mockReturnValue(found([]));
  axios.post.mockResolvedValue({ data: [el(0, 0, 600)] });

  await getDrivingMatrix([A], [B]);

  const [ops, opts] = DriveTime.bulkWrite.mock.calls[0];
  expect(opts).toEqual({ ordered: false });
  expect(ops[0].updateOne.filter).toEqual({ _id: key(A, B) });
  expect(ops[0].updateOne.update.$set).toMatchObject({ minutes: 10, traffic: false });
  expect(ops[0].updateOne.upsert).toBe(true);
});

it("makes no Google call when everything is stored", async () => {
  DriveTime.find.mockReturnValue(found([{ _id: key(A, B), minutes: 4 }, { _id: key(A, C), minutes: 9 }]));
  expect(await getDrivingMatrix([A], [B, C])).toEqual([[4, 9]]);
  expect(axios.post).not.toHaveBeenCalled();
  expect(DriveTime.bulkWrite).not.toHaveBeenCalled();
});

it("still works when the store fails", async () => {
  DriveTime.find.mockImplementation(() => { throw new Error("db down"); });
  axios.post.mockResolvedValue({ data: [el(0, 0, 300)] });
  expect(await getDrivingMatrix([A], [B])).toEqual([[5]]);
});

it("skips the store without a database connection", async () => {
  isDbReady.mockReturnValue(false);
  axios.post.mockResolvedValue({ data: [el(0, 0, 300)] });
  expect(await getDrivingMatrix([A], [B])).toEqual([[5]]);
  expect(DriveTime.find).not.toHaveBeenCalled();
  expect(DriveTime.bulkWrite).not.toHaveBeenCalled();
});

it("expires stored drive times after 30 days", () => {
  const real = jest.requireActual("../../src/models/driveTimeModel");
  expect(real.schema.path("fetchedAt").options.expires).toBe(30 * 24 * 60 * 60);
});
