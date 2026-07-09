import type { Account } from "./Account";
export type GetAccountResponse = {
    account: Account | null;
    requiresOpenaiAuth: boolean;
};
