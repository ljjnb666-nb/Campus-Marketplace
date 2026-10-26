import { PageContainer } from "@/components/ui/page-container";
import { MessagesCenterClient } from "@/components/conversation/messages-center-client";
import { requireUser } from "@/lib/server-auth";
import {
  getConversationListItems,
} from "@/repositories/conversation-repository";

export const dynamic = "force-dynamic";

export default async function MessagesPage() {
  const user = await requireUser();
  const conversations = await getConversationListItems(user.id);

  return (
    <PageContainer maxWidth="full" className="py-4">
      <MessagesCenterClient
        currentUserId={user.id}
        conversations={conversations}
      />
    </PageContainer>
  );
}
