import { expect, it } from "vitest";
import { FEDERATED_HTTP_ROUTES, FEDERATED_WEBSOCKET_ROUTES } from "./federatedRoutes.js";

it("federates exactly one GET workspace file view route", () => {
  expect(FEDERATED_HTTP_ROUTES.filter((s) => s.path === "/projects/:projectId/workspaces/:workspaceId/file/view")).toEqual([
    { method: "GET", path: "/projects/:projectId/workspaces/:workspaceId/file/view" },
  ]);
});

it("adds no mutation or socket counterpart for file view", () => {
  expect(FEDERATED_HTTP_ROUTES.filter((s) => s.path.endsWith("/file/view") && s.method !== "GET")).toEqual([]);
  expect(FEDERATED_WEBSOCKET_ROUTES.filter((p) => p.endsWith("/file/view"))).toEqual([]);
});
