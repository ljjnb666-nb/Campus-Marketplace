"use client";

import { useRouter } from "next/navigation";
import { ConversationLayout } from "@/components/conversation/conversation-layout";
import type { ConversationListItem, ConversationDetailPayload } from "@/repositories/conversation-repository";

interface MessagesCenterClientProps {
  currentUserId: string;
  conversations: ConversationListItem[];
  activeConversationPayload?: ConversationDetailPayload | null;
  activeId?: string;
}

export function MessagesCenterClient({
  currentUserId,
  conversations,
  activeConversationPayload,
  activeId,
}: MessagesCenterClientProps) {
  const router = useRouter();

  const handleSelectConversation = (id: string) => {
    if (!id) {
      router.push("/messages");
    } else {
      router.push(`/messages/${id}`);
    }
  };

  const handleRefresh = () => {
    router.refresh();
  };

  return (
    <ConversationLayout
      currentUserId={currentUserId}
      conversations={conversations}
      activeConversationPayload={activeConversationPayload}
      activeId={activeId}
      onSelectConversation={handleSelectConversation}
      onRefresh={handleRefresh}
    />
  );
}
