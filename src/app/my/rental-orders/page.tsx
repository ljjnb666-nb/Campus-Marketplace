import { redirect } from "next/navigation";

export default function MyRentalOrdersRedirectPage() {
  redirect("/my/orders?type=rental-renter");
}
