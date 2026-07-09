import type { ImageDetail } from "./ImageDetail";
export type ContentItem = {
    "type": "input_text";
    text: string;
} | {
    "type": "input_image";
    image_url: string;
    detail?: ImageDetail;
} | {
    "type": "output_text";
    text: string;
};
