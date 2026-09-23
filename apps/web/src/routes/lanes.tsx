import { createFileRoute } from "@tanstack/react-router";

import { LanesPage } from "../components/continuity/LanesPage";

// continuity: the lane board and memory panel.
export const Route = createFileRoute("/lanes")({
  component: LanesPage,
});
