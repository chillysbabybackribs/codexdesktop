import type { ToolRequestUserInputAnswer } from "./ToolRequestUserInputAnswer";
/**
 * EXPERIMENTAL. Response payload mapping question ids to answers.
 */
export type ToolRequestUserInputResponse = {
    answers: {
        [key in string]?: ToolRequestUserInputAnswer;
    };
};
