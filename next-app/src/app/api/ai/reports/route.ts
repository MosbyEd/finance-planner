import { listReports } from "@/server/aiReports";
import { corsPreflight, jsonOk, withUser } from "@/server/http";

/** Разборы трат от AI и итоги периодов (их создаёт POST /api/ai/chat с полем analysis), новые первыми. */

export const OPTIONS = corsPreflight;

export const GET = withUser((_req, { user }) => jsonOk({ reports: listReports(user.id) }));
