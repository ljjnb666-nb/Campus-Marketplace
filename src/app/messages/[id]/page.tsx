import { notFound } from "next/navigation";
import { PageContainer } from "@/components/ui/page-container";
import { MessagesCenterClient } from "@/components/conversation/messages-center-client";
import { requireUser } from "@/lib/server-auth";
import {
  getConversationDetailPayload,
  getConversationListItems,
} from "@/repositories/conversation-repository";

export const dynamic = "force-dynamic";

interface MessageDetailPageProps {
  params: Promise<{ id: string }>;
}

export default async function MessageDetailPage({ params }: MessageDetailPageProps) {
  const user = await requireUser();
  const { id } = await params;

  const conversations = await getConversationListItems(user.id);
  const activeConversationPayload = await getConversationDetailPayload(id, user.id);

  if (!activeConversationPayload) {
    notFound();
  }

  return (
    <PageContainer maxWidth="full" className="py-4">
      <MessagesCenterClient
        currentUserId={user.id}
        conversations={conversations}
        activeConversationPayload={activeConversationPayload}
        activeId={id}
      />
    </PageContainer>
  );
}
