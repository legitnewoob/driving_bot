/**
 * If Google retires the fast date-reading model, extraction switches to the main model.
 */
jest.mock("../../src/utils/logger-advanced", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockFast = { generateContent: jest.fn() };
const mockMain = { generateContent: jest.fn() };
jest.mock("../../src/config/gemini", () => ({ fastModel: mockFast, model: mockMain }));

const DateTimeService = require("../../src/services/gemini/dateTimeService");

const ok = (date) => ({
  response: {
    text: () => JSON.stringify({ hasDateTime: true, date, time: null, confidence: "high", explicitDate: true, explicitTime: false }),
  },
});

it("falls back to the main model when the fast one has been retired", async () => {
  mockFast.generateContent.mockRejectedValue(new Error("[404 Not Found] This model models/x is no longer available to new users"));
  mockMain.generateContent.mockResolvedValue(ok("2030-10-21"));

  const first = await DateTimeService.extractWithGemini("next Wed");
  expect(first.date).toBe("2030-10-21");
  expect(mockMain.generateContent).toHaveBeenCalledTimes(1);

  // and keeps using it without trying the dead model again
  await DateTimeService.extractWithGemini("next Fri");
  expect(mockFast.generateContent).toHaveBeenCalledTimes(1);
  expect(mockMain.generateContent).toHaveBeenCalledTimes(2);
});
