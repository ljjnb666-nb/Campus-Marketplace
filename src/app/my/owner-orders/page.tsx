import { redirect } from "next/navigation";

export default function MyOwnerOrdersRedirectPage() {
  redirect("/my/orders?type=rental-owner");
}
