import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getMyServiceFavorites } from "@/actions/service-favorite";

export async function GET() {
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
    console.error("Error fetching service favorites:", error);
    return NextResponse.json(
      { error: "Failed to fetch favorites" },
      { status: 500 }
    );
  }
}
