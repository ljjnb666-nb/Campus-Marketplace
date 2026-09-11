import { NextResponse } from "next/server";
import { getVerifiedSession } from "@/lib/server-auth";
import { handleError } from "@/lib/error-handler";
import { getMyServiceFavorites } from "@/actions/service-favorite";
import { withHttpMetrics } from "@/lib/http-metrics";

async function getHandler() {
  try {
    // Phase 6C-2 raw-auth hardening：私有收藏读必须 ACTIVE 账号 DB 复查
    const verified = await getVerifiedSession();

    if (!verified.ok) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    const favorites = await getMyServiceFavorites(verified.user.id);

    return NextResponse.json({ favorites });
  } catch (error) {
    const handled = handleError(error, "GET /api/favorites/services");
    return NextResponse.json(
      { error: handled.message },
      { status: handled.statusCode }
    );
  }
}

export const GET = withHttpMetrics("favorites/services", getHandler);
