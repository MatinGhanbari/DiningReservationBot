/**
 * Raw shapes returned by the Samad API.
 *
 * These mirror the upstream payloads exactly, including their quirks, and are
 * deliberately kept apart from the domain models. Samad's field names are
 * inconsistent (`forgotCardCode` next to `forgetCode`, `id` meaning different
 * things per endpoint) and its types are loose. Isolating all of that here means
 * a change upstream is a one-file change, and the rest of the codebase keeps
 * working with clean types.
 *
 * Every field is optional. These payloads come from a system we do not control
 * and that has changed shape before; a missing field should degrade a screen,
 * not throw during deserialisation.
 */

export interface SamadEnvelope {
  type?: string;
  code?: number;
  message?: string;
  messageFa?: string;
  messageResource?: string;
}

export interface SamadTokenResponse {
  access_token?: string;
  token_type?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  user_id?: number;
  first_name?: string;
  last_name?: string;
  national_code?: string;
  jti?: string;
}

export interface SamadSelf {
  id?: number;
  name?: string;
}

export interface SamadSelfListResponse extends SamadEnvelope {
  payload?: SamadSelf[];
}

export interface SamadReservedMeal {
  id?: number;
  programId?: number;
  programDate?: string;
  selfId?: number;
  selfCodeName?: string;
  mealTypeId?: number;
  foodTypeId?: number;
  foodNames?: string;
  remainedCount?: number;
  price?: number;
}

export interface SamadMealType {
  mealTypeId?: number;
  name?: string;
  date?: string;
  reserve?: SamadReservedMeal;
  dateTime?: number;
}

export interface SamadWeekDay {
  day?: string;
  dayTranslated?: string;
  date?: string;
  dateJStr?: string;
  mealTypes?: SamadMealType[];
}

export interface SamadReservesResponse extends SamadEnvelope {
  payload?: {
    weekDays?: SamadWeekDay[];
    mealTypes?: Array<{ id?: number; name?: string; disPriority?: number }>;
    remainCredit?: number;
  };
}

export interface SamadProgramFoodType {
  programId?: number;
  foodTypeId?: number;
  foodTypeTitle?: string;
  foodList?: string[];
  price?: number;
  foodNames?: string;
  besideFoodNames?: string;
  standardFoodNames?: string;
}

export interface SamadSelfProgram {
  programId?: number;
  groupId?: number;
  date?: string;
  selfId?: number;
  mealTypeId?: number;
  mealTypeName?: string;
  dayTranslated?: string;
  programFoodTypes?: SamadProgramFoodType[];
  daysDifferenceWithToday?: number;
  cancelRuleViolated?: boolean;
  reserveRuleViolated?: boolean;
  dateTime?: number;
}

export interface SamadProgramsResponse extends SamadEnvelope {
  payload?: {
    selfWeekPrograms?: SamadSelfProgram[][];
    userWeekReserves?: SamadReservedMeal[];
    remainCredit?: number;
  };
}

export interface SamadReserveResponse extends SamadEnvelope {
  /** `SUCCESS` or `ERROR`; treated case-insensitively. */
  type?: string;
}

export interface SamadProfileResponse extends SamadEnvelope {
  payload?: {
    credit?: number;
    user?: {
      firstName?: string;
      lastName?: string;
      username?: string;
    };
  };
}

export interface SamadForgetCodeResponse extends SamadEnvelope {
  payload?: {
    username?: string;
    deliverDate?: string;
    deliverTime?: string;
    self?: string;
    meal?: string;
    foodType?: string;
    foodName?: string;
    count?: number;
    remainCount?: number;
    valid?: boolean;
    /**
     * The actual code. Samad also sends a `forgetCode` field in some responses,
     * which is not the card code — the original implementation mixed the two up
     * and checked uniqueness against the wrong value.
     */
    forgotCardCode?: string;
  };
}
