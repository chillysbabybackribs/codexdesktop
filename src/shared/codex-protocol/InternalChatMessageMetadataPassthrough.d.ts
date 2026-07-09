/**
 * Internal Responses API passthrough metadata copied into underlying chat messages.
 *
 * Responses API strongly types this payload. Do not modify it without first getting API
 * approval and making the corresponding Responses API change.
 */
export type InternalChatMessageMetadataPassthrough = {
    turn_id?: string;
};
