import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { routerPush, ImageUploader } = vi.hoisted(() => ({
  routerPush: vi.fn(),
  ImageUploader: vi.fn(({ images }: { images: Array<{ url: string }> }) => (
    <div data-testid="image-uploader">{images.length} 张图片</div>
  )),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush }),
}));

vi.mock("@/components/shared/image-uploader", () => ({
  ImageUploader,
}));

import { RentalListingForm } from "@/components/rental/rental-listing-form";

const categories = [{ id: "cat-1", name: "数码设备" }];

function buildAction() {
  return vi.fn(async () => ({ success: false, message: "" }));
}

function field(name: string) {
  const el = document.querySelector(`[name="${name}"]`);
  if (!el) throw new Error(`field ${name} not found`);
  return el as HTMLInputElement;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("RentalListingForm", () => {
  it("renders all required sections with campus default locations", () => {
    render(
      <RentalListingForm
        categories={categories}
        currentCampusName="示例大学"
        action={buildAction()}
      />,
    );

    expect(screen.getByText("基本信息")).toBeInTheDocument();
    expect(screen.getByText("价格与租期")).toBeInTheDocument();
    expect(screen.getByText("交接与详情")).toBeInTheDocument();
    expect(screen.getByText("图片上传")).toBeInTheDocument();
    expect(screen.getByText("发布租赁")).toBeInTheDocument();

    expect(field("pickupLocation")).toHaveValue("示例大学");
    expect(field("returnLocation")).toHaveValue("示例大学");
    expect(field("title")).toHaveValue("");
    expect(screen.getByText("数码设备")).toBeInTheDocument();
  });

  it("prefills existing listing values and shows the save button in edit mode", () => {
    render(
      <RentalListingForm
        categories={categories}
        currentCampusName="示例大学"
        listingId="listing-1"
        action={buildAction()}
        defaultValues={{
          title: "佳能相机出租",
          categoryId: "cat-1",
          condition: "EXCELLENT",
          brand: "Canon",
          price: 50,
          pricingUnit: "PER_DAY",
          depositAmount: 200,
          pickupLocation: "东门",
          returnLocation: "东门",
          description: "95新相机",
          images: ["/uploads/a.webp"],
        }}
      />,
    );

    expect(field("title")).toHaveValue("佳能相机出租");
    expect(field("pickupLocation")).toHaveValue("东门");
    expect(field("brand")).toHaveValue("Canon");
    expect(screen.getByText("保存修改")).toBeInTheDocument();
    expect(screen.getByTestId("image-uploader")).toHaveTextContent("1 张图片");
  });

  it("toggles the manual approval checkbox off when configured", () => {
    render(
      <RentalListingForm
        categories={categories}
        currentCampusName="示例大学"
        action={buildAction()}
        defaultValues={{ requiresApproval: false }}
      />,
    );

    expect(field("requiresApproval")).not.toBeChecked();
  });

  it("keeps typed input values", () => {
    render(
      <RentalListingForm
        categories={categories}
        currentCampusName="示例大学"
        action={buildAction()}
      />,
    );

    fireEvent.change(field("title"), { target: { value: "无人机出租" } });

    expect(field("title")).toHaveValue("无人机出租");
  });
});
