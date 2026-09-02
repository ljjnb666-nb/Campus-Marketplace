import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { handleError } from "@/lib/error-handler";
import { getMyServiceFavorites } from "@/actions/service-favorite";
import { withHttpMetrics } from "@/lib/http-metrics";

async function getHandler() {
  try {
    const session = await auth();

    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    const favorites = await getMyServiceFavorites(session.user.id);

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
