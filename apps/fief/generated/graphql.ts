import gql from 'graphql-tag';
import { TypedDocumentNode as DocumentNode } from '@graphql-typed-document-node/core';
type JSONValue = string | number | boolean | null | { [key: string]: JSONValue } | JSONValue[];
export type Maybe<T> = T | null;
export type InputMaybe<T> = Maybe<T>;
export type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
export type MakeOptional<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]?: Maybe<T[SubKey]> };
export type MakeMaybe<T, K extends keyof T> = Omit<T, K> & { [SubKey in K]: Maybe<T[SubKey]> };
export type MakeEmpty<T extends { [key: string]: unknown }, K extends keyof T> = { [_ in K]?: never };
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
export type Omit<T, K extends keyof T> = Pick<T, Exclude<keyof T, K>>;
/** All built-in and custom scalars, mapped to their actual values */
export type Scalars = {
  ID: { input: string; output: string; }
  String: { input: string; output: string; }
  Boolean: { input: boolean; output: boolean; }
  Int: { input: number; output: number; }
  Float: { input: number; output: number; }
  /**
   * The `Date` scalar type represents a Date
   * value as specified by
   * [iso8601](https://en.wikipedia.org/wiki/ISO_8601).
   */
  Date: { input: string; output: string; }
  /**
   * The `DateTime` scalar type represents a DateTime
   * value as specified by
   * [iso8601](https://en.wikipedia.org/wiki/ISO_8601).
   */
  DateTime: { input: string; output: string; }
  /** The `Day` scalar type represents number of days by integer value. */
  Day: { input: string; output: string; }
  /**
   * Custom Decimal implementation.
   *
   * Returns Decimal as a float in the API,
   * parses float to the Decimal on the way back.
   */
  Decimal: { input: number; output: number; }
  /**
   * The `GenericScalar` scalar type represents a generic
   * GraphQL scalar value that could be:
   * String, Boolean, Int, Float, List or Object.
   */
  GenericScalar: { input: JSONValue; output: JSONValue; }
  /** The `Hour` scalar type represents number of hours by integer value. */
  Hour: { input: number; output: number; }
  JSON: { input: JSONValue; output: JSONValue; }
  JSONString: { input: string; output: string; }
  /**
   * Metadata is a map of key-value pairs, both keys and values are `String`.
   *
   * Example:
   * ```
   * {
   *     "key1": "value1",
   *     "key2": "value2"
   * }
   * ```
   */
  Metadata: { input: Record<string, string>; output: Record<string, string>; }
  /** The `Minute` scalar type represents number of minutes by integer value. */
  Minute: { input: number; output: number; }
  /**
   * Nonnegative Decimal scalar implementation.
   *
   * Should be used in places where value must be nonnegative (0 or greater).
   */
  PositiveDecimal: { input: number; output: number; }
  /**
   * Positive Integer scalar implementation.
   *
   * Should be used in places where value must be positive (greater than 0).
   */
  PositiveInt: { input: number; output: number; }
  UUID: { input: string; output: string; }
  /** Variables of this type must be set to null in mutations. They will be replaced with a filename from a following multipart part containing a binary file. See: https://github.com/jaydenseric/graphql-multipart-request-spec. */
  Upload: { input: unknown; output: unknown; }
  WeightScalar: { input: number; output: number; }
  /** _Any value scalar as defined by Federation spec. */
  _Any: { input: unknown; output: unknown; }
};

export type AccountErrorCode =
  | 'ACCOUNT_NOT_CONFIRMED'
  | 'ACTIVATE_OWN_ACCOUNT'
  | 'ACTIVATE_SUPERUSER_ACCOUNT'
  | 'CHANNEL_INACTIVE'
  | 'DEACTIVATE_OWN_ACCOUNT'
  | 'DEACTIVATE_SUPERUSER_ACCOUNT'
  | 'DELETE_NON_STAFF_USER'
  | 'DELETE_OWN_ACCOUNT'
  | 'DELETE_STAFF_ACCOUNT'
  | 'DELETE_SUPERUSER_ACCOUNT'
  | 'DISABLED_AUTHENTICATION_METHOD'
  | 'DUPLICATED_INPUT_ITEM'
  | 'FILE_SIZE_LIMIT_EXCEEDED'
  | 'GRAPHQL_ERROR'
  | 'INACTIVE'
  | 'INVALID'
  | 'INVALID_CREDENTIALS'
  | 'INVALID_PASSWORD'
  | 'JWT_DECODE_ERROR'
  | 'JWT_INVALID_CSRF_TOKEN'
  | 'JWT_INVALID_TOKEN'
  | 'JWT_MISSING_TOKEN'
  | 'JWT_SIGNATURE_EXPIRED'
  | 'LEFT_NOT_MANAGEABLE_PERMISSION'
  | 'LOGIN_ATTEMPT_DELAYED'
  | 'MISSING_CHANNEL_SLUG'
  | 'NOT_FOUND'
  | 'OUT_OF_SCOPE_GROUP'
  | 'OUT_OF_SCOPE_PERMISSION'
  | 'OUT_OF_SCOPE_USER'
  | 'PASSWORD_ENTIRELY_NUMERIC'
  | 'PASSWORD_RESET_ALREADY_REQUESTED'
  | 'PASSWORD_TOO_COMMON'
  | 'PASSWORD_TOO_SHORT'
  | 'PASSWORD_TOO_SIMILAR'
  | 'REQUIRED'
  | 'UNIQUE'
  | 'UNKNOWN_IP_ADDRESS';

export type AddressInput = {
  /** City. */
  readonly city?: InputMaybe<Scalars['String']['input']>;
  /** District. */
  readonly cityArea?: InputMaybe<Scalars['String']['input']>;
  /** Company or organization. */
  readonly companyName?: InputMaybe<Scalars['String']['input']>;
  /** Country. */
  readonly country?: InputMaybe<CountryCode>;
  /** State or province. */
  readonly countryArea?: InputMaybe<Scalars['String']['input']>;
  /** Given name. */
  readonly firstName?: InputMaybe<Scalars['String']['input']>;
  /** Family name. */
  readonly lastName?: InputMaybe<Scalars['String']['input']>;
  /**
   * Address public metadata. Can be read by any API client authorized to read the object it's attached to.
   *
   * Warning: never store sensitive information, including financial data such as credit card details.
   */
  readonly metadata?: InputMaybe<ReadonlyArray<MetadataInput>>;
  /**
   * Phone number.
   *
   * Phone numbers are validated with Google's [libphonenumber](https://github.com/google/libphonenumber) library.
   */
  readonly phone?: InputMaybe<Scalars['String']['input']>;
  /** Postal code. */
  readonly postalCode?: InputMaybe<Scalars['String']['input']>;
  /**
   * Determine if the address should be validated. By default, Saleor accepts only address inputs matching ruleset from [Google Address Data]{https://chromium-i18n.appspot.com/ssl-address), using [i18naddress](https://github.com/mirumee/google-i18n-address) library. Some mutations may require additional permissions to use the the field. More info about permissions can be found in relevant mutation.
   *
   * Added in Saleor 3.19.
   *
   * Note: this API is currently in Feature Preview and can be subject to changes at later point.
   */
  readonly skipValidation?: InputMaybe<Scalars['Boolean']['input']>;
  /** Address. */
  readonly streetAddress1?: InputMaybe<Scalars['String']['input']>;
  /** Address. */
  readonly streetAddress2?: InputMaybe<Scalars['String']['input']>;
};

/**
 * Represents country codes defined by the ISO 3166-1 alpha-2 standard.
 *
 * The `EU` value is DEPRECATED and will be removed in Saleor 3.21.
 */
export type CountryCode =
  /** Andorra */
  | 'AD'
  /** United Arab Emirates */
  | 'AE'
  /** Afghanistan */
  | 'AF'
  /** Antigua and Barbuda */
  | 'AG'
  /** Anguilla */
  | 'AI'
  /** Albania */
  | 'AL'
  /** Armenia */
  | 'AM'
  /** Angola */
  | 'AO'
  /** Antarctica */
  | 'AQ'
  /** Argentina */
  | 'AR'
  /** American Samoa */
  | 'AS'
  /** Austria */
  | 'AT'
  /** Australia */
  | 'AU'
  /** Aruba */
  | 'AW'
  /** Åland Islands */
  | 'AX'
  /** Azerbaijan */
  | 'AZ'
  /** Bosnia and Herzegovina */
  | 'BA'
  /** Barbados */
  | 'BB'
  /** Bangladesh */
  | 'BD'
  /** Belgium */
  | 'BE'
  /** Burkina Faso */
  | 'BF'
  /** Bulgaria */
  | 'BG'
  /** Bahrain */
  | 'BH'
  /** Burundi */
  | 'BI'
  /** Benin */
  | 'BJ'
  /** Saint Barthélemy */
  | 'BL'
  /** Bermuda */
  | 'BM'
  /** Brunei */
  | 'BN'
  /** Bolivia */
  | 'BO'
  /** Bonaire, Sint Eustatius and Saba */
  | 'BQ'
  /** Brazil */
  | 'BR'
  /** Bahamas */
  | 'BS'
  /** Bhutan */
  | 'BT'
  /** Bouvet Island */
  | 'BV'
  /** Botswana */
  | 'BW'
  /** Belarus */
  | 'BY'
  /** Belize */
  | 'BZ'
  /** Canada */
  | 'CA'
  /** Cocos (Keeling) Islands */
  | 'CC'
  /** Congo (the Democratic Republic of the) */
  | 'CD'
  /** Central African Republic */
  | 'CF'
  /** Congo */
  | 'CG'
  /** Switzerland */
  | 'CH'
  /** Côte d'Ivoire */
  | 'CI'
  /** Cook Islands */
  | 'CK'
  /** Chile */
  | 'CL'
  /** Cameroon */
  | 'CM'
  /** China */
  | 'CN'
  /** Colombia */
  | 'CO'
  /** Costa Rica */
  | 'CR'
  /** Cuba */
  | 'CU'
  /** Cabo Verde */
  | 'CV'
  /** Curaçao */
  | 'CW'
  /** Christmas Island */
  | 'CX'
  /** Cyprus */
  | 'CY'
  /** Czechia */
  | 'CZ'
  /** Germany */
  | 'DE'
  /** Djibouti */
  | 'DJ'
  /** Denmark */
  | 'DK'
  /** Dominica */
  | 'DM'
  /** Dominican Republic */
  | 'DO'
  /** Algeria */
  | 'DZ'
  /** Ecuador */
  | 'EC'
  /** Estonia */
  | 'EE'
  /** Egypt */
  | 'EG'
  /** Western Sahara */
  | 'EH'
  /** Eritrea */
  | 'ER'
  /** Spain */
  | 'ES'
  /** Ethiopia */
  | 'ET'
  /** European Union */
  | 'EU'
  /** Finland */
  | 'FI'
  /** Fiji */
  | 'FJ'
  /** Falkland Islands (Malvinas) */
  | 'FK'
  /** Micronesia */
  | 'FM'
  /** Faroe Islands */
  | 'FO'
  /** France */
  | 'FR'
  /** Gabon */
  | 'GA'
  /** United Kingdom */
  | 'GB'
  /** Grenada */
  | 'GD'
  /** Georgia */
  | 'GE'
  /** French Guiana */
  | 'GF'
  /** Guernsey */
  | 'GG'
  /** Ghana */
  | 'GH'
  /** Gibraltar */
  | 'GI'
  /** Greenland */
  | 'GL'
  /** Gambia */
  | 'GM'
  /** Guinea */
  | 'GN'
  /** Guadeloupe */
  | 'GP'
  /** Equatorial Guinea */
  | 'GQ'
  /** Greece */
  | 'GR'
  /** South Georgia and the South Sandwich Islands */
  | 'GS'
  /** Guatemala */
  | 'GT'
  /** Guam */
  | 'GU'
  /** Guinea-Bissau */
  | 'GW'
  /** Guyana */
  | 'GY'
  /** Hong Kong */
  | 'HK'
  /** Heard Island and McDonald Islands */
  | 'HM'
  /** Honduras */
  | 'HN'
  /** Croatia */
  | 'HR'
  /** Haiti */
  | 'HT'
  /** Hungary */
  | 'HU'
  /** Indonesia */
  | 'ID'
  /** Ireland */
  | 'IE'
  /** Israel */
  | 'IL'
  /** Isle of Man */
  | 'IM'
  /** India */
  | 'IN'
  /** British Indian Ocean Territory */
  | 'IO'
  /** Iraq */
  | 'IQ'
  /** Iran */
  | 'IR'
  /** Iceland */
  | 'IS'
  /** Italy */
  | 'IT'
  /** Jersey */
  | 'JE'
  /** Jamaica */
  | 'JM'
  /** Jordan */
  | 'JO'
  /** Japan */
  | 'JP'
  /** Kenya */
  | 'KE'
  /** Kyrgyzstan */
  | 'KG'
  /** Cambodia */
  | 'KH'
  /** Kiribati */
  | 'KI'
  /** Comoros */
  | 'KM'
  /** Saint Kitts and Nevis */
  | 'KN'
  /** North Korea */
  | 'KP'
  /** South Korea */
  | 'KR'
  /** Kuwait */
  | 'KW'
  /** Cayman Islands */
  | 'KY'
  /** Kazakhstan */
  | 'KZ'
  /** Laos */
  | 'LA'
  /** Lebanon */
  | 'LB'
  /** Saint Lucia */
  | 'LC'
  /** Liechtenstein */
  | 'LI'
  /** Sri Lanka */
  | 'LK'
  /** Liberia */
  | 'LR'
  /** Lesotho */
  | 'LS'
  /** Lithuania */
  | 'LT'
  /** Luxembourg */
  | 'LU'
  /** Latvia */
  | 'LV'
  /** Libya */
  | 'LY'
  /** Morocco */
  | 'MA'
  /** Monaco */
  | 'MC'
  /** Moldova */
  | 'MD'
  /** Montenegro */
  | 'ME'
  /** Saint Martin (French part) */
  | 'MF'
  /** Madagascar */
  | 'MG'
  /** Marshall Islands */
  | 'MH'
  /** North Macedonia */
  | 'MK'
  /** Mali */
  | 'ML'
  /** Myanmar */
  | 'MM'
  /** Mongolia */
  | 'MN'
  /** Macao */
  | 'MO'
  /** Northern Mariana Islands */
  | 'MP'
  /** Martinique */
  | 'MQ'
  /** Mauritania */
  | 'MR'
  /** Montserrat */
  | 'MS'
  /** Malta */
  | 'MT'
  /** Mauritius */
  | 'MU'
  /** Maldives */
  | 'MV'
  /** Malawi */
  | 'MW'
  /** Mexico */
  | 'MX'
  /** Malaysia */
  | 'MY'
  /** Mozambique */
  | 'MZ'
  /** Namibia */
  | 'NA'
  /** New Caledonia */
  | 'NC'
  /** Niger */
  | 'NE'
  /** Norfolk Island */
  | 'NF'
  /** Nigeria */
  | 'NG'
  /** Nicaragua */
  | 'NI'
  /** Netherlands */
  | 'NL'
  /** Norway */
  | 'NO'
  /** Nepal */
  | 'NP'
  /** Nauru */
  | 'NR'
  /** Niue */
  | 'NU'
  /** New Zealand */
  | 'NZ'
  /** Oman */
  | 'OM'
  /** Panama */
  | 'PA'
  /** Peru */
  | 'PE'
  /** French Polynesia */
  | 'PF'
  /** Papua New Guinea */
  | 'PG'
  /** Philippines */
  | 'PH'
  /** Pakistan */
  | 'PK'
  /** Poland */
  | 'PL'
  /** Saint Pierre and Miquelon */
  | 'PM'
  /** Pitcairn */
  | 'PN'
  /** Puerto Rico */
  | 'PR'
  /** Palestine, State of */
  | 'PS'
  /** Portugal */
  | 'PT'
  /** Palau */
  | 'PW'
  /** Paraguay */
  | 'PY'
  /** Qatar */
  | 'QA'
  /** Réunion */
  | 'RE'
  /** Romania */
  | 'RO'
  /** Serbia */
  | 'RS'
  /** Russia */
  | 'RU'
  /** Rwanda */
  | 'RW'
  /** Saudi Arabia */
  | 'SA'
  /** Solomon Islands */
  | 'SB'
  /** Seychelles */
  | 'SC'
  /** Sudan */
  | 'SD'
  /** Sweden */
  | 'SE'
  /** Singapore */
  | 'SG'
  /** Saint Helena, Ascension and Tristan da Cunha */
  | 'SH'
  /** Slovenia */
  | 'SI'
  /** Svalbard and Jan Mayen */
  | 'SJ'
  /** Slovakia */
  | 'SK'
  /** Sierra Leone */
  | 'SL'
  /** San Marino */
  | 'SM'
  /** Senegal */
  | 'SN'
  /** Somalia */
  | 'SO'
  /** Suriname */
  | 'SR'
  /** South Sudan */
  | 'SS'
  /** Sao Tome and Principe */
  | 'ST'
  /** El Salvador */
  | 'SV'
  /** Sint Maarten (Dutch part) */
  | 'SX'
  /** Syria */
  | 'SY'
  /** Eswatini */
  | 'SZ'
  /** Turks and Caicos Islands */
  | 'TC'
  /** Chad */
  | 'TD'
  /** French Southern Territories */
  | 'TF'
  /** Togo */
  | 'TG'
  /** Thailand */
  | 'TH'
  /** Tajikistan */
  | 'TJ'
  /** Tokelau */
  | 'TK'
  /** Timor-Leste */
  | 'TL'
  /** Turkmenistan */
  | 'TM'
  /** Tunisia */
  | 'TN'
  /** Tonga */
  | 'TO'
  /** Türkiye */
  | 'TR'
  /** Trinidad and Tobago */
  | 'TT'
  /** Tuvalu */
  | 'TV'
  /** Taiwan */
  | 'TW'
  /** Tanzania */
  | 'TZ'
  /** Ukraine */
  | 'UA'
  /** Uganda */
  | 'UG'
  /** United States Minor Outlying Islands */
  | 'UM'
  /** United States of America */
  | 'US'
  /** Uruguay */
  | 'UY'
  /** Uzbekistan */
  | 'UZ'
  /** Holy See */
  | 'VA'
  /** Saint Vincent and the Grenadines */
  | 'VC'
  /** Venezuela */
  | 'VE'
  /** Virgin Islands (British) */
  | 'VG'
  /** Virgin Islands (U.S.) */
  | 'VI'
  /** Vietnam */
  | 'VN'
  /** Vanuatu */
  | 'VU'
  /** Wallis and Futuna */
  | 'WF'
  /** Samoa */
  | 'WS'
  /** Kosovo */
  | 'XK'
  /** Yemen */
  | 'YE'
  /** Mayotte */
  | 'YT'
  /** South Africa */
  | 'ZA'
  /** Zambia */
  | 'ZM'
  /** Zimbabwe */
  | 'ZW';

export type CustomerBulkUpdateErrorCode =
  | 'BLANK'
  | 'DUPLICATED_INPUT_ITEM'
  | 'GRAPHQL_ERROR'
  | 'INVALID'
  | 'MAX_LENGTH'
  | 'NOT_FOUND'
  | 'REQUIRED'
  | 'UNIQUE';

export type CustomerBulkUpdateInput = {
  /** External ID of a customer to update. */
  readonly externalReference?: InputMaybe<Scalars['String']['input']>;
  /** ID of a customer to update. */
  readonly id?: InputMaybe<Scalars['ID']['input']>;
  /** Fields required to update a customer. */
  readonly input: CustomerInput;
};

export type CustomerInput = {
  /** Billing address of the customer. */
  readonly defaultBillingAddress?: InputMaybe<AddressInput>;
  /** Shipping address of the customer. */
  readonly defaultShippingAddress?: InputMaybe<AddressInput>;
  /** The unique email address of the user. */
  readonly email?: InputMaybe<Scalars['String']['input']>;
  /** External ID of the customer. */
  readonly externalReference?: InputMaybe<Scalars['String']['input']>;
  /** Given name. */
  readonly firstName?: InputMaybe<Scalars['String']['input']>;
  /** User account is active. */
  readonly isActive?: InputMaybe<Scalars['Boolean']['input']>;
  /** User account is confirmed. */
  readonly isConfirmed?: InputMaybe<Scalars['Boolean']['input']>;
  /** User language code. */
  readonly languageCode?: InputMaybe<LanguageCodeEnum>;
  /** Family name. */
  readonly lastName?: InputMaybe<Scalars['String']['input']>;
  /**
   * Fields required to update the user metadata. Can be read by any API client authorized to read the object it's attached to.
   *
   * Warning: never store sensitive information, including financial data such as credit card details.
   */
  readonly metadata?: InputMaybe<ReadonlyArray<MetadataInput>>;
  /** A note about the user. */
  readonly note?: InputMaybe<Scalars['String']['input']>;
  /**
   * Fields required to update the user private metadata. Requires permissions to modify and to read the metadata of the object it's attached to.
   *
   * Warning: never store sensitive information, including financial data such as credit card details.
   */
  readonly privateMetadata?: InputMaybe<ReadonlyArray<MetadataInput>>;
};

export type ErrorPolicyEnum =
  /** Save what is possible within a single row. If there are errors in an input data row, try to save it partially and skip the invalid part. */
  | 'IGNORE_FAILED'
  /** Reject all rows if there is at least one error in any of them. */
  | 'REJECT_EVERYTHING'
  /** Reject rows with errors. */
  | 'REJECT_FAILED_ROWS';

/** Language code enum. It contains all the languages supported by Saleor. */
export type LanguageCodeEnum =
  /** Afrikaans */
  | 'AF'
  /** Afrikaans (Namibia) */
  | 'AF_NA'
  /** Afrikaans (South Africa) */
  | 'AF_ZA'
  /** Aghem */
  | 'AGQ'
  /** Aghem (Cameroon) */
  | 'AGQ_CM'
  /** Akan */
  | 'AK'
  /** Akan (Ghana) */
  | 'AK_GH'
  /** Amharic */
  | 'AM'
  /** Amharic (Ethiopia) */
  | 'AM_ET'
  /** Arabic */
  | 'AR'
  /** Arabic (United Arab Emirates) */
  | 'AR_AE'
  /** Arabic (Bahrain) */
  | 'AR_BH'
  /** Arabic (Djibouti) */
  | 'AR_DJ'
  /** Arabic (Algeria) */
  | 'AR_DZ'
  /** Arabic (Egypt) */
  | 'AR_EG'
  /** Arabic (Western Sahara) */
  | 'AR_EH'
  /** Arabic (Eritrea) */
  | 'AR_ER'
  /** Arabic (Israel) */
  | 'AR_IL'
  /** Arabic (Iraq) */
  | 'AR_IQ'
  /** Arabic (Jordan) */
  | 'AR_JO'
  /** Arabic (Comoros) */
  | 'AR_KM'
  /** Arabic (Kuwait) */
  | 'AR_KW'
  /** Arabic (Lebanon) */
  | 'AR_LB'
  /** Arabic (Libya) */
  | 'AR_LY'
  /** Arabic (Morocco) */
  | 'AR_MA'
  /** Arabic (Mauritania) */
  | 'AR_MR'
  /** Arabic (Oman) */
  | 'AR_OM'
  /** Arabic (Palestinian Territories) */
  | 'AR_PS'
  /** Arabic (Qatar) */
  | 'AR_QA'
  /** Arabic (Saudi Arabia) */
  | 'AR_SA'
  /** Arabic (Sudan) */
  | 'AR_SD'
  /** Arabic (Somalia) */
  | 'AR_SO'
  /** Arabic (South Sudan) */
  | 'AR_SS'
  /** Arabic (Syria) */
  | 'AR_SY'
  /** Arabic (Chad) */
  | 'AR_TD'
  /** Arabic (Tunisia) */
  | 'AR_TN'
  /** Arabic (Yemen) */
  | 'AR_YE'
  /** Assamese */
  | 'AS'
  /** Asu */
  | 'ASA'
  /** Asu (Tanzania) */
  | 'ASA_TZ'
  /** Asturian */
  | 'AST'
  /** Asturian (Spain) */
  | 'AST_ES'
  /** Assamese (India) */
  | 'AS_IN'
  /** Azerbaijani */
  | 'AZ'
  /** Azerbaijani (Cyrillic) */
  | 'AZ_CYRL'
  /** Azerbaijani (Cyrillic, Azerbaijan) */
  | 'AZ_CYRL_AZ'
  /** Azerbaijani (Latin) */
  | 'AZ_LATN'
  /** Azerbaijani (Latin, Azerbaijan) */
  | 'AZ_LATN_AZ'
  /** Basaa */
  | 'BAS'
  /** Basaa (Cameroon) */
  | 'BAS_CM'
  /** Belarusian */
  | 'BE'
  /** Bemba */
  | 'BEM'
  /** Bemba (Zambia) */
  | 'BEM_ZM'
  /** Bena */
  | 'BEZ'
  /** Bena (Tanzania) */
  | 'BEZ_TZ'
  /** Belarusian (Belarus) */
  | 'BE_BY'
  /** Bulgarian */
  | 'BG'
  /** Bulgarian (Bulgaria) */
  | 'BG_BG'
  /** Bambara */
  | 'BM'
  /** Bambara (Mali) */
  | 'BM_ML'
  /** Bangla */
  | 'BN'
  /** Bangla (Bangladesh) */
  | 'BN_BD'
  /** Bangla (India) */
  | 'BN_IN'
  /** Tibetan */
  | 'BO'
  /** Tibetan (China) */
  | 'BO_CN'
  /** Tibetan (India) */
  | 'BO_IN'
  /** Breton */
  | 'BR'
  /** Bodo */
  | 'BRX'
  /** Bodo (India) */
  | 'BRX_IN'
  /** Breton (France) */
  | 'BR_FR'
  /** Bosnian */
  | 'BS'
  /** Bosnian (Cyrillic) */
  | 'BS_CYRL'
  /** Bosnian (Cyrillic, Bosnia & Herzegovina) */
  | 'BS_CYRL_BA'
  /** Bosnian (Latin) */
  | 'BS_LATN'
  /** Bosnian (Latin, Bosnia & Herzegovina) */
  | 'BS_LATN_BA'
  /** Catalan */
  | 'CA'
  /** Catalan (Andorra) */
  | 'CA_AD'
  /** Catalan (Spain) */
  | 'CA_ES'
  /** Catalan (Spain, Valencian) */
  | 'CA_ES_VALENCIA'
  /** Catalan (France) */
  | 'CA_FR'
  /** Catalan (Italy) */
  | 'CA_IT'
  /** Chakma */
  | 'CCP'
  /** Chakma (Bangladesh) */
  | 'CCP_BD'
  /** Chakma (India) */
  | 'CCP_IN'
  /** Chechen */
  | 'CE'
  /** Cebuano */
  | 'CEB'
  /** Cebuano (Philippines) */
  | 'CEB_PH'
  /** Chechen (Russia) */
  | 'CE_RU'
  /** Chiga */
  | 'CGG'
  /** Chiga (Uganda) */
  | 'CGG_UG'
  /** Cherokee */
  | 'CHR'
  /** Cherokee (United States) */
  | 'CHR_US'
  /** Central Kurdish */
  | 'CKB'
  /** Central Kurdish (Iraq) */
  | 'CKB_IQ'
  /** Central Kurdish (Iran) */
  | 'CKB_IR'
  /** Czech */
  | 'CS'
  /** Czech (Czechia) */
  | 'CS_CZ'
  /** Church Slavic */
  | 'CU'
  /** Church Slavic (Russia) */
  | 'CU_RU'
  /** Welsh */
  | 'CY'
  /** Welsh (United Kingdom) */
  | 'CY_GB'
  /** Danish */
  | 'DA'
  /** Taita */
  | 'DAV'
  /** Taita (Kenya) */
  | 'DAV_KE'
  /** Danish (Denmark) */
  | 'DA_DK'
  /** Danish (Greenland) */
  | 'DA_GL'
  /** German */
  | 'DE'
  /** German (Austria) */
  | 'DE_AT'
  /** German (Belgium) */
  | 'DE_BE'
  /** German (Switzerland) */
  | 'DE_CH'
  /** German (Germany) */
  | 'DE_DE'
  /** German (Italy) */
  | 'DE_IT'
  /** German (Liechtenstein) */
  | 'DE_LI'
  /** German (Luxembourg) */
  | 'DE_LU'
  /** Zarma */
  | 'DJE'
  /** Zarma (Niger) */
  | 'DJE_NE'
  /** Lower Sorbian */
  | 'DSB'
  /** Lower Sorbian (Germany) */
  | 'DSB_DE'
  /** Duala */
  | 'DUA'
  /** Duala (Cameroon) */
  | 'DUA_CM'
  /** Jola-Fonyi */
  | 'DYO'
  /** Jola-Fonyi (Senegal) */
  | 'DYO_SN'
  /** Dzongkha */
  | 'DZ'
  /** Dzongkha (Bhutan) */
  | 'DZ_BT'
  /** Embu */
  | 'EBU'
  /** Embu (Kenya) */
  | 'EBU_KE'
  /** Ewe */
  | 'EE'
  /** Ewe (Ghana) */
  | 'EE_GH'
  /** Ewe (Togo) */
  | 'EE_TG'
  /** Greek */
  | 'EL'
  /** Greek (Cyprus) */
  | 'EL_CY'
  /** Greek (Greece) */
  | 'EL_GR'
  /** English */
  | 'EN'
  /** English (United Arab Emirates) */
  | 'EN_AE'
  /** English (Antigua & Barbuda) */
  | 'EN_AG'
  /** English (Anguilla) */
  | 'EN_AI'
  /** English (American Samoa) */
  | 'EN_AS'
  /** English (Austria) */
  | 'EN_AT'
  /** English (Australia) */
  | 'EN_AU'
  /** English (Barbados) */
  | 'EN_BB'
  /** English (Belgium) */
  | 'EN_BE'
  /** English (Burundi) */
  | 'EN_BI'
  /** English (Bermuda) */
  | 'EN_BM'
  /** English (Bahamas) */
  | 'EN_BS'
  /** English (Botswana) */
  | 'EN_BW'
  /** English (Belize) */
  | 'EN_BZ'
  /** English (Canada) */
  | 'EN_CA'
  /** English (Cocos (Keeling) Islands) */
  | 'EN_CC'
  /** English (Switzerland) */
  | 'EN_CH'
  /** English (Cook Islands) */
  | 'EN_CK'
  /** English (Cameroon) */
  | 'EN_CM'
  /** English (Christmas Island) */
  | 'EN_CX'
  /** English (Cyprus) */
  | 'EN_CY'
  /** English (Germany) */
  | 'EN_DE'
  /** English (Diego Garcia) */
  | 'EN_DG'
  /** English (Denmark) */
  | 'EN_DK'
  /** English (Dominica) */
  | 'EN_DM'
  /** English (Eritrea) */
  | 'EN_ER'
  /** English (Finland) */
  | 'EN_FI'
  /** English (Fiji) */
  | 'EN_FJ'
  /** English (Falkland Islands) */
  | 'EN_FK'
  /** English (Micronesia) */
  | 'EN_FM'
  /** English (United Kingdom) */
  | 'EN_GB'
  /** English (Grenada) */
  | 'EN_GD'
  /** English (Guernsey) */
  | 'EN_GG'
  /** English (Ghana) */
  | 'EN_GH'
  /** English (Gibraltar) */
  | 'EN_GI'
  /** English (Gambia) */
  | 'EN_GM'
  /** English (Guam) */
  | 'EN_GU'
  /** English (Guyana) */
  | 'EN_GY'
  /** English (Hong Kong SAR China) */
  | 'EN_HK'
  /** English (Ireland) */
  | 'EN_IE'
  /** English (Israel) */
  | 'EN_IL'
  /** English (Isle of Man) */
  | 'EN_IM'
  /** English (India) */
  | 'EN_IN'
  /** English (British Indian Ocean Territory) */
  | 'EN_IO'
  /** English (Jersey) */
  | 'EN_JE'
  /** English (Jamaica) */
  | 'EN_JM'
  /** English (Kenya) */
  | 'EN_KE'
  /** English (Kiribati) */
  | 'EN_KI'
  /** English (St. Kitts & Nevis) */
  | 'EN_KN'
  /** English (Cayman Islands) */
  | 'EN_KY'
  /** English (St. Lucia) */
  | 'EN_LC'
  /** English (Liberia) */
  | 'EN_LR'
  /** English (Lesotho) */
  | 'EN_LS'
  /** English (Madagascar) */
  | 'EN_MG'
  /** English (Marshall Islands) */
  | 'EN_MH'
  /** English (Macao SAR China) */
  | 'EN_MO'
  /** English (Northern Mariana Islands) */
  | 'EN_MP'
  /** English (Montserrat) */
  | 'EN_MS'
  /** English (Malta) */
  | 'EN_MT'
  /** English (Mauritius) */
  | 'EN_MU'
  /** English (Malawi) */
  | 'EN_MW'
  /** English (Malaysia) */
  | 'EN_MY'
  /** English (Namibia) */
  | 'EN_NA'
  /** English (Norfolk Island) */
  | 'EN_NF'
  /** English (Nigeria) */
  | 'EN_NG'
  /** English (Netherlands) */
  | 'EN_NL'
  /** English (Nauru) */
  | 'EN_NR'
  /** English (Niue) */
  | 'EN_NU'
  /** English (New Zealand) */
  | 'EN_NZ'
  /** English (Papua New Guinea) */
  | 'EN_PG'
  /** English (Philippines) */
  | 'EN_PH'
  /** English (Pakistan) */
  | 'EN_PK'
  /** English (Pitcairn Islands) */
  | 'EN_PN'
  /** English (Puerto Rico) */
  | 'EN_PR'
  /** English (Palau) */
  | 'EN_PW'
  /** English (Rwanda) */
  | 'EN_RW'
  /** English (Solomon Islands) */
  | 'EN_SB'
  /** English (Seychelles) */
  | 'EN_SC'
  /** English (Sudan) */
  | 'EN_SD'
  /** English (Sweden) */
  | 'EN_SE'
  /** English (Singapore) */
  | 'EN_SG'
  /** English (St. Helena) */
  | 'EN_SH'
  /** English (Slovenia) */
  | 'EN_SI'
  /** English (Sierra Leone) */
  | 'EN_SL'
  /** English (South Sudan) */
  | 'EN_SS'
  /** English (Sint Maarten) */
  | 'EN_SX'
  /** English (Eswatini) */
  | 'EN_SZ'
  /** English (Turks & Caicos Islands) */
  | 'EN_TC'
  /** English (Tokelau) */
  | 'EN_TK'
  /** English (Tonga) */
  | 'EN_TO'
  /** English (Trinidad & Tobago) */
  | 'EN_TT'
  /** English (Tuvalu) */
  | 'EN_TV'
  /** English (Tanzania) */
  | 'EN_TZ'
  /** English (Uganda) */
  | 'EN_UG'
  /** English (U.S. Outlying Islands) */
  | 'EN_UM'
  /** English (United States) */
  | 'EN_US'
  /** English (St. Vincent & Grenadines) */
  | 'EN_VC'
  /** English (British Virgin Islands) */
  | 'EN_VG'
  /** English (U.S. Virgin Islands) */
  | 'EN_VI'
  /** English (Vanuatu) */
  | 'EN_VU'
  /** English (Samoa) */
  | 'EN_WS'
  /** English (South Africa) */
  | 'EN_ZA'
  /** English (Zambia) */
  | 'EN_ZM'
  /** English (Zimbabwe) */
  | 'EN_ZW'
  /** Esperanto */
  | 'EO'
  /** Spanish */
  | 'ES'
  /** Spanish (Argentina) */
  | 'ES_AR'
  /** Spanish (Bolivia) */
  | 'ES_BO'
  /** Spanish (Brazil) */
  | 'ES_BR'
  /** Spanish (Belize) */
  | 'ES_BZ'
  /** Spanish (Chile) */
  | 'ES_CL'
  /** Spanish (Colombia) */
  | 'ES_CO'
  /** Spanish (Costa Rica) */
  | 'ES_CR'
  /** Spanish (Cuba) */
  | 'ES_CU'
  /** Spanish (Dominican Republic) */
  | 'ES_DO'
  /** Spanish (Ceuta & Melilla) */
  | 'ES_EA'
  /** Spanish (Ecuador) */
  | 'ES_EC'
  /** Spanish (Spain) */
  | 'ES_ES'
  /** Spanish (Equatorial Guinea) */
  | 'ES_GQ'
  /** Spanish (Guatemala) */
  | 'ES_GT'
  /** Spanish (Honduras) */
  | 'ES_HN'
  /** Spanish (Canary Islands) */
  | 'ES_IC'
  /** Spanish (Mexico) */
  | 'ES_MX'
  /** Spanish (Nicaragua) */
  | 'ES_NI'
  /** Spanish (Panama) */
  | 'ES_PA'
  /** Spanish (Peru) */
  | 'ES_PE'
  /** Spanish (Philippines) */
  | 'ES_PH'
  /** Spanish (Puerto Rico) */
  | 'ES_PR'
  /** Spanish (Paraguay) */
  | 'ES_PY'
  /** Spanish (El Salvador) */
  | 'ES_SV'
  /** Spanish (United States) */
  | 'ES_US'
  /** Spanish (Uruguay) */
  | 'ES_UY'
  /** Spanish (Venezuela) */
  | 'ES_VE'
  /** Estonian */
  | 'ET'
  /** Estonian (Estonia) */
  | 'ET_EE'
  /** Basque */
  | 'EU'
  /** Basque (Spain) */
  | 'EU_ES'
  /** Ewondo */
  | 'EWO'
  /** Ewondo (Cameroon) */
  | 'EWO_CM'
  /** Persian */
  | 'FA'
  /** Persian (Afghanistan) */
  | 'FA_AF'
  /** Persian (Iran) */
  | 'FA_IR'
  /** Fulah */
  | 'FF'
  /** Fulah (Adlam) */
  | 'FF_ADLM'
  /** Fulah (Adlam, Burkina Faso) */
  | 'FF_ADLM_BF'
  /** Fulah (Adlam, Cameroon) */
  | 'FF_ADLM_CM'
  /** Fulah (Adlam, Ghana) */
  | 'FF_ADLM_GH'
  /** Fulah (Adlam, Gambia) */
  | 'FF_ADLM_GM'
  /** Fulah (Adlam, Guinea) */
  | 'FF_ADLM_GN'
  /** Fulah (Adlam, Guinea-Bissau) */
  | 'FF_ADLM_GW'
  /** Fulah (Adlam, Liberia) */
  | 'FF_ADLM_LR'
  /** Fulah (Adlam, Mauritania) */
  | 'FF_ADLM_MR'
  /** Fulah (Adlam, Niger) */
  | 'FF_ADLM_NE'
  /** Fulah (Adlam, Nigeria) */
  | 'FF_ADLM_NG'
  /** Fulah (Adlam, Sierra Leone) */
  | 'FF_ADLM_SL'
  /** Fulah (Adlam, Senegal) */
  | 'FF_ADLM_SN'
  /** Fulah (Latin) */
  | 'FF_LATN'
  /** Fulah (Latin, Burkina Faso) */
  | 'FF_LATN_BF'
  /** Fulah (Latin, Cameroon) */
  | 'FF_LATN_CM'
  /** Fulah (Latin, Ghana) */
  | 'FF_LATN_GH'
  /** Fulah (Latin, Gambia) */
  | 'FF_LATN_GM'
  /** Fulah (Latin, Guinea) */
  | 'FF_LATN_GN'
  /** Fulah (Latin, Guinea-Bissau) */
  | 'FF_LATN_GW'
  /** Fulah (Latin, Liberia) */
  | 'FF_LATN_LR'
  /** Fulah (Latin, Mauritania) */
  | 'FF_LATN_MR'
  /** Fulah (Latin, Niger) */
  | 'FF_LATN_NE'
  /** Fulah (Latin, Nigeria) */
  | 'FF_LATN_NG'
  /** Fulah (Latin, Sierra Leone) */
  | 'FF_LATN_SL'
  /** Fulah (Latin, Senegal) */
  | 'FF_LATN_SN'
  /** Finnish */
  | 'FI'
  /** Filipino */
  | 'FIL'
  /** Filipino (Philippines) */
  | 'FIL_PH'
  /** Finnish (Finland) */
  | 'FI_FI'
  /** Faroese */
  | 'FO'
  /** Faroese (Denmark) */
  | 'FO_DK'
  /** Faroese (Faroe Islands) */
  | 'FO_FO'
  /** French */
  | 'FR'
  /** French (Belgium) */
  | 'FR_BE'
  /** French (Burkina Faso) */
  | 'FR_BF'
  /** French (Burundi) */
  | 'FR_BI'
  /** French (Benin) */
  | 'FR_BJ'
  /** French (St. Barthélemy) */
  | 'FR_BL'
  /** French (Canada) */
  | 'FR_CA'
  /** French (Congo - Kinshasa) */
  | 'FR_CD'
  /** French (Central African Republic) */
  | 'FR_CF'
  /** French (Congo - Brazzaville) */
  | 'FR_CG'
  /** French (Switzerland) */
  | 'FR_CH'
  /** French (Côte d’Ivoire) */
  | 'FR_CI'
  /** French (Cameroon) */
  | 'FR_CM'
  /** French (Djibouti) */
  | 'FR_DJ'
  /** French (Algeria) */
  | 'FR_DZ'
  /** French (France) */
  | 'FR_FR'
  /** French (Gabon) */
  | 'FR_GA'
  /** French (French Guiana) */
  | 'FR_GF'
  /** French (Guinea) */
  | 'FR_GN'
  /** French (Guadeloupe) */
  | 'FR_GP'
  /** French (Equatorial Guinea) */
  | 'FR_GQ'
  /** French (Haiti) */
  | 'FR_HT'
  /** French (Comoros) */
  | 'FR_KM'
  /** French (Luxembourg) */
  | 'FR_LU'
  /** French (Morocco) */
  | 'FR_MA'
  /** French (Monaco) */
  | 'FR_MC'
  /** French (St. Martin) */
  | 'FR_MF'
  /** French (Madagascar) */
  | 'FR_MG'
  /** French (Mali) */
  | 'FR_ML'
  /** French (Martinique) */
  | 'FR_MQ'
  /** French (Mauritania) */
  | 'FR_MR'
  /** French (Mauritius) */
  | 'FR_MU'
  /** French (New Caledonia) */
  | 'FR_NC'
  /** French (Niger) */
  | 'FR_NE'
  /** French (French Polynesia) */
  | 'FR_PF'
  /** French (St. Pierre & Miquelon) */
  | 'FR_PM'
  /** French (Réunion) */
  | 'FR_RE'
  /** French (Rwanda) */
  | 'FR_RW'
  /** French (Seychelles) */
  | 'FR_SC'
  /** French (Senegal) */
  | 'FR_SN'
  /** French (Syria) */
  | 'FR_SY'
  /** French (Chad) */
  | 'FR_TD'
  /** French (Togo) */
  | 'FR_TG'
  /** French (Tunisia) */
  | 'FR_TN'
  /** French (Vanuatu) */
  | 'FR_VU'
  /** French (Wallis & Futuna) */
  | 'FR_WF'
  /** French (Mayotte) */
  | 'FR_YT'
  /** Friulian */
  | 'FUR'
  /** Friulian (Italy) */
  | 'FUR_IT'
  /** Western Frisian */
  | 'FY'
  /** Western Frisian (Netherlands) */
  | 'FY_NL'
  /** Irish */
  | 'GA'
  /** Irish (United Kingdom) */
  | 'GA_GB'
  /** Irish (Ireland) */
  | 'GA_IE'
  /** Scottish Gaelic */
  | 'GD'
  /** Scottish Gaelic (United Kingdom) */
  | 'GD_GB'
  /** Galician */
  | 'GL'
  /** Galician (Spain) */
  | 'GL_ES'
  /** Swiss German */
  | 'GSW'
  /** Swiss German (Switzerland) */
  | 'GSW_CH'
  /** Swiss German (France) */
  | 'GSW_FR'
  /** Swiss German (Liechtenstein) */
  | 'GSW_LI'
  /** Gujarati */
  | 'GU'
  /** Gusii */
  | 'GUZ'
  /** Gusii (Kenya) */
  | 'GUZ_KE'
  /** Gujarati (India) */
  | 'GU_IN'
  /** Manx */
  | 'GV'
  /** Manx (Isle of Man) */
  | 'GV_IM'
  /** Hausa */
  | 'HA'
  /** Hawaiian */
  | 'HAW'
  /** Hawaiian (United States) */
  | 'HAW_US'
  /** Hausa (Ghana) */
  | 'HA_GH'
  /** Hausa (Niger) */
  | 'HA_NE'
  /** Hausa (Nigeria) */
  | 'HA_NG'
  /** Hebrew */
  | 'HE'
  /** Hebrew (Israel) */
  | 'HE_IL'
  /** Hindi */
  | 'HI'
  /** Hindi (India) */
  | 'HI_IN'
  /** Croatian */
  | 'HR'
  /** Croatian (Bosnia & Herzegovina) */
  | 'HR_BA'
  /** Croatian (Croatia) */
  | 'HR_HR'
  /** Upper Sorbian */
  | 'HSB'
  /** Upper Sorbian (Germany) */
  | 'HSB_DE'
  /** Hungarian */
  | 'HU'
  /** Hungarian (Hungary) */
  | 'HU_HU'
  /** Armenian */
  | 'HY'
  /** Armenian (Armenia) */
  | 'HY_AM'
  /** Interlingua */
  | 'IA'
  /** Indonesian */
  | 'ID'
  /** Indonesian (Indonesia) */
  | 'ID_ID'
  /** Igbo */
  | 'IG'
  /** Igbo (Nigeria) */
  | 'IG_NG'
  /** Sichuan Yi */
  | 'II'
  /** Sichuan Yi (China) */
  | 'II_CN'
  /** Icelandic */
  | 'IS'
  /** Icelandic (Iceland) */
  | 'IS_IS'
  /** Italian */
  | 'IT'
  /** Italian (Switzerland) */
  | 'IT_CH'
  /** Italian (Italy) */
  | 'IT_IT'
  /** Italian (San Marino) */
  | 'IT_SM'
  /** Italian (Vatican City) */
  | 'IT_VA'
  /** Japanese */
  | 'JA'
  /** Japanese (Japan) */
  | 'JA_JP'
  /** Ngomba */
  | 'JGO'
  /** Ngomba (Cameroon) */
  | 'JGO_CM'
  /** Machame */
  | 'JMC'
  /** Machame (Tanzania) */
  | 'JMC_TZ'
  /** Javanese */
  | 'JV'
  /** Javanese (Indonesia) */
  | 'JV_ID'
  /** Georgian */
  | 'KA'
  /** Kabyle */
  | 'KAB'
  /** Kabyle (Algeria) */
  | 'KAB_DZ'
  /** Kamba */
  | 'KAM'
  /** Kamba (Kenya) */
  | 'KAM_KE'
  /** Georgian (Georgia) */
  | 'KA_GE'
  /** Makonde */
  | 'KDE'
  /** Makonde (Tanzania) */
  | 'KDE_TZ'
  /** Kabuverdianu */
  | 'KEA'
  /** Kabuverdianu (Cape Verde) */
  | 'KEA_CV'
  /** Koyra Chiini */
  | 'KHQ'
  /** Koyra Chiini (Mali) */
  | 'KHQ_ML'
  /** Kikuyu */
  | 'KI'
  /** Kikuyu (Kenya) */
  | 'KI_KE'
  /** Kazakh */
  | 'KK'
  /** Kako */
  | 'KKJ'
  /** Kako (Cameroon) */
  | 'KKJ_CM'
  /** Kazakh (Kazakhstan) */
  | 'KK_KZ'
  /** Kalaallisut */
  | 'KL'
  /** Kalenjin */
  | 'KLN'
  /** Kalenjin (Kenya) */
  | 'KLN_KE'
  /** Kalaallisut (Greenland) */
  | 'KL_GL'
  /** Khmer */
  | 'KM'
  /** Khmer (Cambodia) */
  | 'KM_KH'
  /** Kannada */
  | 'KN'
  /** Kannada (India) */
  | 'KN_IN'
  /** Korean */
  | 'KO'
  /** Konkani */
  | 'KOK'
  /** Konkani (India) */
  | 'KOK_IN'
  /** Korean (North Korea) */
  | 'KO_KP'
  /** Korean (South Korea) */
  | 'KO_KR'
  /** Kashmiri */
  | 'KS'
  /** Shambala */
  | 'KSB'
  /** Shambala (Tanzania) */
  | 'KSB_TZ'
  /** Bafia */
  | 'KSF'
  /** Bafia (Cameroon) */
  | 'KSF_CM'
  /** Colognian */
  | 'KSH'
  /** Colognian (Germany) */
  | 'KSH_DE'
  /** Kashmiri (Arabic) */
  | 'KS_ARAB'
  /** Kashmiri (Arabic, India) */
  | 'KS_ARAB_IN'
  /** Kurdish */
  | 'KU'
  /** Kurdish (Turkey) */
  | 'KU_TR'
  /** Cornish */
  | 'KW'
  /** Cornish (United Kingdom) */
  | 'KW_GB'
  /** Kyrgyz */
  | 'KY'
  /** Kyrgyz (Kyrgyzstan) */
  | 'KY_KG'
  /** Langi */
  | 'LAG'
  /** Langi (Tanzania) */
  | 'LAG_TZ'
  /** Luxembourgish */
  | 'LB'
  /** Luxembourgish (Luxembourg) */
  | 'LB_LU'
  /** Ganda */
  | 'LG'
  /** Ganda (Uganda) */
  | 'LG_UG'
  /** Lakota */
  | 'LKT'
  /** Lakota (United States) */
  | 'LKT_US'
  /** Lingala */
  | 'LN'
  /** Lingala (Angola) */
  | 'LN_AO'
  /** Lingala (Congo - Kinshasa) */
  | 'LN_CD'
  /** Lingala (Central African Republic) */
  | 'LN_CF'
  /** Lingala (Congo - Brazzaville) */
  | 'LN_CG'
  /** Lao */
  | 'LO'
  /** Lao (Laos) */
  | 'LO_LA'
  /** Northern Luri */
  | 'LRC'
  /** Northern Luri (Iraq) */
  | 'LRC_IQ'
  /** Northern Luri (Iran) */
  | 'LRC_IR'
  /** Lithuanian */
  | 'LT'
  /** Lithuanian (Lithuania) */
  | 'LT_LT'
  /** Luba-Katanga */
  | 'LU'
  /** Luo */
  | 'LUO'
  /** Luo (Kenya) */
  | 'LUO_KE'
  /** Luyia */
  | 'LUY'
  /** Luyia (Kenya) */
  | 'LUY_KE'
  /** Luba-Katanga (Congo - Kinshasa) */
  | 'LU_CD'
  /** Latvian */
  | 'LV'
  /** Latvian (Latvia) */
  | 'LV_LV'
  /** Maithili */
  | 'MAI'
  /** Maithili (India) */
  | 'MAI_IN'
  /** Masai */
  | 'MAS'
  /** Masai (Kenya) */
  | 'MAS_KE'
  /** Masai (Tanzania) */
  | 'MAS_TZ'
  /** Meru */
  | 'MER'
  /** Meru (Kenya) */
  | 'MER_KE'
  /** Morisyen */
  | 'MFE'
  /** Morisyen (Mauritius) */
  | 'MFE_MU'
  /** Malagasy */
  | 'MG'
  /** Makhuwa-Meetto */
  | 'MGH'
  /** Makhuwa-Meetto (Mozambique) */
  | 'MGH_MZ'
  /** Metaʼ */
  | 'MGO'
  /** Metaʼ (Cameroon) */
  | 'MGO_CM'
  /** Malagasy (Madagascar) */
  | 'MG_MG'
  /** Maori */
  | 'MI'
  /** Maori (New Zealand) */
  | 'MI_NZ'
  /** Macedonian */
  | 'MK'
  /** Macedonian (North Macedonia) */
  | 'MK_MK'
  /** Malayalam */
  | 'ML'
  /** Malayalam (India) */
  | 'ML_IN'
  /** Mongolian */
  | 'MN'
  /** Manipuri */
  | 'MNI'
  /** Manipuri (Bangla) */
  | 'MNI_BENG'
  /** Manipuri (Bangla, India) */
  | 'MNI_BENG_IN'
  /** Mongolian (Mongolia) */
  | 'MN_MN'
  /** Marathi */
  | 'MR'
  /** Marathi (India) */
  | 'MR_IN'
  /** Malay */
  | 'MS'
  /** Malay (Brunei) */
  | 'MS_BN'
  /** Malay (Indonesia) */
  | 'MS_ID'
  /** Malay (Malaysia) */
  | 'MS_MY'
  /** Malay (Singapore) */
  | 'MS_SG'
  /** Maltese */
  | 'MT'
  /** Maltese (Malta) */
  | 'MT_MT'
  /** Mundang */
  | 'MUA'
  /** Mundang (Cameroon) */
  | 'MUA_CM'
  /** Burmese */
  | 'MY'
  /** Burmese (Myanmar (Burma)) */
  | 'MY_MM'
  /** Mazanderani */
  | 'MZN'
  /** Mazanderani (Iran) */
  | 'MZN_IR'
  /** Nama */
  | 'NAQ'
  /** Nama (Namibia) */
  | 'NAQ_NA'
  /** Norwegian Bokmål */
  | 'NB'
  /** Norwegian Bokmål (Norway) */
  | 'NB_NO'
  /** Norwegian Bokmål (Svalbard & Jan Mayen) */
  | 'NB_SJ'
  /** North Ndebele */
  | 'ND'
  /** Low German */
  | 'NDS'
  /** Low German (Germany) */
  | 'NDS_DE'
  /** Low German (Netherlands) */
  | 'NDS_NL'
  /** North Ndebele (Zimbabwe) */
  | 'ND_ZW'
  /** Nepali */
  | 'NE'
  /** Nepali (India) */
  | 'NE_IN'
  /** Nepali (Nepal) */
  | 'NE_NP'
  /** Dutch */
  | 'NL'
  /** Dutch (Aruba) */
  | 'NL_AW'
  /** Dutch (Belgium) */
  | 'NL_BE'
  /** Dutch (Caribbean Netherlands) */
  | 'NL_BQ'
  /** Dutch (Curaçao) */
  | 'NL_CW'
  /** Dutch (Netherlands) */
  | 'NL_NL'
  /** Dutch (Suriname) */
  | 'NL_SR'
  /** Dutch (Sint Maarten) */
  | 'NL_SX'
  /** Kwasio */
  | 'NMG'
  /** Kwasio (Cameroon) */
  | 'NMG_CM'
  /** Norwegian Nynorsk */
  | 'NN'
  /** Ngiemboon */
  | 'NNH'
  /** Ngiemboon (Cameroon) */
  | 'NNH_CM'
  /** Norwegian Nynorsk (Norway) */
  | 'NN_NO'
  /** Nuer */
  | 'NUS'
  /** Nuer (South Sudan) */
  | 'NUS_SS'
  /** Nyankole */
  | 'NYN'
  /** Nyankole (Uganda) */
  | 'NYN_UG'
  /** Oromo */
  | 'OM'
  /** Oromo (Ethiopia) */
  | 'OM_ET'
  /** Oromo (Kenya) */
  | 'OM_KE'
  /** Odia */
  | 'OR'
  /** Odia (India) */
  | 'OR_IN'
  /** Ossetic */
  | 'OS'
  /** Ossetic (Georgia) */
  | 'OS_GE'
  /** Ossetic (Russia) */
  | 'OS_RU'
  /** Punjabi */
  | 'PA'
  /** Punjabi (Arabic) */
  | 'PA_ARAB'
  /** Punjabi (Arabic, Pakistan) */
  | 'PA_ARAB_PK'
  /** Punjabi (Gurmukhi) */
  | 'PA_GURU'
  /** Punjabi (Gurmukhi, India) */
  | 'PA_GURU_IN'
  /** Nigerian Pidgin */
  | 'PCM'
  /** Nigerian Pidgin (Nigeria) */
  | 'PCM_NG'
  /** Polish */
  | 'PL'
  /** Polish (Poland) */
  | 'PL_PL'
  /** Prussian */
  | 'PRG'
  /** Pashto */
  | 'PS'
  /** Pashto (Afghanistan) */
  | 'PS_AF'
  /** Pashto (Pakistan) */
  | 'PS_PK'
  /** Portuguese */
  | 'PT'
  /** Portuguese (Angola) */
  | 'PT_AO'
  /** Portuguese (Brazil) */
  | 'PT_BR'
  /** Portuguese (Switzerland) */
  | 'PT_CH'
  /** Portuguese (Cape Verde) */
  | 'PT_CV'
  /** Portuguese (Equatorial Guinea) */
  | 'PT_GQ'
  /** Portuguese (Guinea-Bissau) */
  | 'PT_GW'
  /** Portuguese (Luxembourg) */
  | 'PT_LU'
  /** Portuguese (Macao SAR China) */
  | 'PT_MO'
  /** Portuguese (Mozambique) */
  | 'PT_MZ'
  /** Portuguese (Portugal) */
  | 'PT_PT'
  /** Portuguese (São Tomé & Príncipe) */
  | 'PT_ST'
  /** Portuguese (Timor-Leste) */
  | 'PT_TL'
  /** Quechua */
  | 'QU'
  /** Quechua (Bolivia) */
  | 'QU_BO'
  /** Quechua (Ecuador) */
  | 'QU_EC'
  /** Quechua (Peru) */
  | 'QU_PE'
  /** Romansh */
  | 'RM'
  /** Romansh (Switzerland) */
  | 'RM_CH'
  /** Rundi */
  | 'RN'
  /** Rundi (Burundi) */
  | 'RN_BI'
  /** Romanian */
  | 'RO'
  /** Rombo */
  | 'ROF'
  /** Rombo (Tanzania) */
  | 'ROF_TZ'
  /** Romanian (Moldova) */
  | 'RO_MD'
  /** Romanian (Romania) */
  | 'RO_RO'
  /** Russian */
  | 'RU'
  /** Russian (Belarus) */
  | 'RU_BY'
  /** Russian (Kyrgyzstan) */
  | 'RU_KG'
  /** Russian (Kazakhstan) */
  | 'RU_KZ'
  /** Russian (Moldova) */
  | 'RU_MD'
  /** Russian (Russia) */
  | 'RU_RU'
  /** Russian (Ukraine) */
  | 'RU_UA'
  /** Kinyarwanda */
  | 'RW'
  /** Rwa */
  | 'RWK'
  /** Rwa (Tanzania) */
  | 'RWK_TZ'
  /** Kinyarwanda (Rwanda) */
  | 'RW_RW'
  /** Sakha */
  | 'SAH'
  /** Sakha (Russia) */
  | 'SAH_RU'
  /** Samburu */
  | 'SAQ'
  /** Samburu (Kenya) */
  | 'SAQ_KE'
  /** Santali */
  | 'SAT'
  /** Santali (Ol Chiki) */
  | 'SAT_OLCK'
  /** Santali (Ol Chiki, India) */
  | 'SAT_OLCK_IN'
  /** Sangu */
  | 'SBP'
  /** Sangu (Tanzania) */
  | 'SBP_TZ'
  /** Sindhi */
  | 'SD'
  /** Sindhi (Arabic) */
  | 'SD_ARAB'
  /** Sindhi (Arabic, Pakistan) */
  | 'SD_ARAB_PK'
  /** Sindhi (Devanagari) */
  | 'SD_DEVA'
  /** Sindhi (Devanagari, India) */
  | 'SD_DEVA_IN'
  /** Northern Sami */
  | 'SE'
  /** Sena */
  | 'SEH'
  /** Sena (Mozambique) */
  | 'SEH_MZ'
  /** Koyraboro Senni */
  | 'SES'
  /** Koyraboro Senni (Mali) */
  | 'SES_ML'
  /** Northern Sami (Finland) */
  | 'SE_FI'
  /** Northern Sami (Norway) */
  | 'SE_NO'
  /** Northern Sami (Sweden) */
  | 'SE_SE'
  /** Sango */
  | 'SG'
  /** Sango (Central African Republic) */
  | 'SG_CF'
  /** Tachelhit */
  | 'SHI'
  /** Tachelhit (Latin) */
  | 'SHI_LATN'
  /** Tachelhit (Latin, Morocco) */
  | 'SHI_LATN_MA'
  /** Tachelhit (Tifinagh) */
  | 'SHI_TFNG'
  /** Tachelhit (Tifinagh, Morocco) */
  | 'SHI_TFNG_MA'
  /** Sinhala */
  | 'SI'
  /** Sinhala (Sri Lanka) */
  | 'SI_LK'
  /** Slovak */
  | 'SK'
  /** Slovak (Slovakia) */
  | 'SK_SK'
  /** Slovenian */
  | 'SL'
  /** Slovenian (Slovenia) */
  | 'SL_SI'
  /** Inari Sami */
  | 'SMN'
  /** Inari Sami (Finland) */
  | 'SMN_FI'
  /** Shona */
  | 'SN'
  /** Shona (Zimbabwe) */
  | 'SN_ZW'
  /** Somali */
  | 'SO'
  /** Somali (Djibouti) */
  | 'SO_DJ'
  /** Somali (Ethiopia) */
  | 'SO_ET'
  /** Somali (Kenya) */
  | 'SO_KE'
  /** Somali (Somalia) */
  | 'SO_SO'
  /** Albanian */
  | 'SQ'
  /** Albanian (Albania) */
  | 'SQ_AL'
  /** Albanian (North Macedonia) */
  | 'SQ_MK'
  /** Albanian (Kosovo) */
  | 'SQ_XK'
  /** Serbian */
  | 'SR'
  /** Serbian (Cyrillic) */
  | 'SR_CYRL'
  /** Serbian (Cyrillic, Bosnia & Herzegovina) */
  | 'SR_CYRL_BA'
  /** Serbian (Cyrillic, Montenegro) */
  | 'SR_CYRL_ME'
  /** Serbian (Cyrillic, Serbia) */
  | 'SR_CYRL_RS'
  /** Serbian (Cyrillic, Kosovo) */
  | 'SR_CYRL_XK'
  /** Serbian (Latin) */
  | 'SR_LATN'
  /** Serbian (Latin, Bosnia & Herzegovina) */
  | 'SR_LATN_BA'
  /** Serbian (Latin, Montenegro) */
  | 'SR_LATN_ME'
  /** Serbian (Latin, Serbia) */
  | 'SR_LATN_RS'
  /** Serbian (Latin, Kosovo) */
  | 'SR_LATN_XK'
  /** Sundanese */
  | 'SU'
  /** Sundanese (Latin) */
  | 'SU_LATN'
  /** Sundanese (Latin, Indonesia) */
  | 'SU_LATN_ID'
  /** Swedish */
  | 'SV'
  /** Swedish (Åland Islands) */
  | 'SV_AX'
  /** Swedish (Finland) */
  | 'SV_FI'
  /** Swedish (Sweden) */
  | 'SV_SE'
  /** Swahili */
  | 'SW'
  /** Swahili (Congo - Kinshasa) */
  | 'SW_CD'
  /** Swahili (Kenya) */
  | 'SW_KE'
  /** Swahili (Tanzania) */
  | 'SW_TZ'
  /** Swahili (Uganda) */
  | 'SW_UG'
  /** Tamil */
  | 'TA'
  /** Tamil (India) */
  | 'TA_IN'
  /** Tamil (Sri Lanka) */
  | 'TA_LK'
  /** Tamil (Malaysia) */
  | 'TA_MY'
  /** Tamil (Singapore) */
  | 'TA_SG'
  /** Telugu */
  | 'TE'
  /** Teso */
  | 'TEO'
  /** Teso (Kenya) */
  | 'TEO_KE'
  /** Teso (Uganda) */
  | 'TEO_UG'
  /** Telugu (India) */
  | 'TE_IN'
  /** Tajik */
  | 'TG'
  /** Tajik (Tajikistan) */
  | 'TG_TJ'
  /** Thai */
  | 'TH'
  /** Thai (Thailand) */
  | 'TH_TH'
  /** Tigrinya */
  | 'TI'
  /** Tigrinya (Eritrea) */
  | 'TI_ER'
  /** Tigrinya (Ethiopia) */
  | 'TI_ET'
  /** Turkmen */
  | 'TK'
  /** Turkmen (Turkmenistan) */
  | 'TK_TM'
  /** Tongan */
  | 'TO'
  /** Tongan (Tonga) */
  | 'TO_TO'
  /** Turkish */
  | 'TR'
  /** Turkish (Cyprus) */
  | 'TR_CY'
  /** Turkish (Turkey) */
  | 'TR_TR'
  /** Tatar */
  | 'TT'
  /** Tatar (Russia) */
  | 'TT_RU'
  /** Tasawaq */
  | 'TWQ'
  /** Tasawaq (Niger) */
  | 'TWQ_NE'
  /** Central Atlas Tamazight */
  | 'TZM'
  /** Central Atlas Tamazight (Morocco) */
  | 'TZM_MA'
  /** Uyghur */
  | 'UG'
  /** Uyghur (China) */
  | 'UG_CN'
  /** Ukrainian */
  | 'UK'
  /** Ukrainian (Ukraine) */
  | 'UK_UA'
  /** Urdu */
  | 'UR'
  /** Urdu (India) */
  | 'UR_IN'
  /** Urdu (Pakistan) */
  | 'UR_PK'
  /** Uzbek */
  | 'UZ'
  /** Uzbek (Arabic) */
  | 'UZ_ARAB'
  /** Uzbek (Arabic, Afghanistan) */
  | 'UZ_ARAB_AF'
  /** Uzbek (Cyrillic) */
  | 'UZ_CYRL'
  /** Uzbek (Cyrillic, Uzbekistan) */
  | 'UZ_CYRL_UZ'
  /** Uzbek (Latin) */
  | 'UZ_LATN'
  /** Uzbek (Latin, Uzbekistan) */
  | 'UZ_LATN_UZ'
  /** Vai */
  | 'VAI'
  /** Vai (Latin) */
  | 'VAI_LATN'
  /** Vai (Latin, Liberia) */
  | 'VAI_LATN_LR'
  /** Vai (Vai) */
  | 'VAI_VAII'
  /** Vai (Vai, Liberia) */
  | 'VAI_VAII_LR'
  /** Vietnamese */
  | 'VI'
  /** Vietnamese (Vietnam) */
  | 'VI_VN'
  /** Volapük */
  | 'VO'
  /** Vunjo */
  | 'VUN'
  /** Vunjo (Tanzania) */
  | 'VUN_TZ'
  /** Walser */
  | 'WAE'
  /** Walser (Switzerland) */
  | 'WAE_CH'
  /** Wolof */
  | 'WO'
  /** Wolof (Senegal) */
  | 'WO_SN'
  /** Xhosa */
  | 'XH'
  /** Xhosa (South Africa) */
  | 'XH_ZA'
  /** Soga */
  | 'XOG'
  /** Soga (Uganda) */
  | 'XOG_UG'
  /** Yangben */
  | 'YAV'
  /** Yangben (Cameroon) */
  | 'YAV_CM'
  /** Yiddish */
  | 'YI'
  /** Yoruba */
  | 'YO'
  /** Yoruba (Benin) */
  | 'YO_BJ'
  /** Yoruba (Nigeria) */
  | 'YO_NG'
  /** Cantonese */
  | 'YUE'
  /** Cantonese (Simplified) */
  | 'YUE_HANS'
  /** Cantonese (Simplified, China) */
  | 'YUE_HANS_CN'
  /** Cantonese (Traditional) */
  | 'YUE_HANT'
  /** Cantonese (Traditional, Hong Kong SAR China) */
  | 'YUE_HANT_HK'
  /** Standard Moroccan Tamazight */
  | 'ZGH'
  /** Standard Moroccan Tamazight (Morocco) */
  | 'ZGH_MA'
  /** Chinese */
  | 'ZH'
  /** Chinese (Simplified) */
  | 'ZH_HANS'
  /** Chinese (Simplified, China) */
  | 'ZH_HANS_CN'
  /** Chinese (Simplified, Hong Kong SAR China) */
  | 'ZH_HANS_HK'
  /** Chinese (Simplified, Macao SAR China) */
  | 'ZH_HANS_MO'
  /** Chinese (Simplified, Singapore) */
  | 'ZH_HANS_SG'
  /** Chinese (Traditional) */
  | 'ZH_HANT'
  /** Chinese (Traditional, Hong Kong SAR China) */
  | 'ZH_HANT_HK'
  /** Chinese (Traditional, Macao SAR China) */
  | 'ZH_HANT_MO'
  /** Chinese (Traditional, Taiwan) */
  | 'ZH_HANT_TW'
  /** Zulu */
  | 'ZU'
  /** Zulu (South Africa) */
  | 'ZU_ZA';

export type MetadataErrorCode =
  | 'GRAPHQL_ERROR'
  | 'INVALID'
  | 'NOT_FOUND'
  | 'NOT_UPDATED'
  | 'REQUIRED';

export type MetadataInput = {
  /** Key of a metadata item. */
  readonly key: Scalars['String']['input'];
  /** Value of a metadata item. */
  readonly value: Scalars['String']['input'];
};

export type UserCreateInput = {
  /** Slug of a channel which will be used for notify user. Optional when only one channel exists. */
  readonly channel?: InputMaybe<Scalars['String']['input']>;
  /** Billing address of the customer. */
  readonly defaultBillingAddress?: InputMaybe<AddressInput>;
  /** Shipping address of the customer. */
  readonly defaultShippingAddress?: InputMaybe<AddressInput>;
  /** The unique email address of the user. */
  readonly email?: InputMaybe<Scalars['String']['input']>;
  /** External ID of the customer. */
  readonly externalReference?: InputMaybe<Scalars['String']['input']>;
  /** Given name. */
  readonly firstName?: InputMaybe<Scalars['String']['input']>;
  /** User account is active. */
  readonly isActive?: InputMaybe<Scalars['Boolean']['input']>;
  /**
   * User account is confirmed.
   * @deprecated The user will be always set as unconfirmed. The confirmation will take place when the user sets the password.
   */
  readonly isConfirmed?: InputMaybe<Scalars['Boolean']['input']>;
  /** User language code. */
  readonly languageCode?: InputMaybe<LanguageCodeEnum>;
  /** Family name. */
  readonly lastName?: InputMaybe<Scalars['String']['input']>;
  /**
   * Fields required to update the user metadata. Can be read by any API client authorized to read the object it's attached to.
   *
   * Warning: never store sensitive information, including financial data such as credit card details.
   */
  readonly metadata?: InputMaybe<ReadonlyArray<MetadataInput>>;
  /** A note about the user. */
  readonly note?: InputMaybe<Scalars['String']['input']>;
  /**
   * Fields required to update the user private metadata. Requires permissions to modify and to read the metadata of the object it's attached to.
   *
   * Warning: never store sensitive information, including financial data such as credit card details.
   */
  readonly privateMetadata?: InputMaybe<ReadonlyArray<MetadataInput>>;
  /** URL of a view where users should be redirected to set the password. URL in RFC 1808 format. */
  readonly redirectUrl?: InputMaybe<Scalars['String']['input']>;
};

export type AccountErrorFragment = { readonly field?: string | null, readonly message?: string | null, readonly code: AccountErrorCode };

export type CustomerBulkUpdateErrorFragment = { readonly path?: string | null, readonly message?: string | null, readonly code: CustomerBulkUpdateErrorCode };

export type FiefCustomerFragment = { readonly id: string, readonly email: string, readonly firstName: string, readonly lastName: string, readonly isActive: boolean, readonly metadata: ReadonlyArray<{ readonly key: string, readonly value: string }>, readonly privateMetadata: ReadonlyArray<{ readonly key: string, readonly value: string }> };

export type MetadataErrorFragment = { readonly field?: string | null, readonly message?: string | null, readonly code: MetadataErrorCode };

export type SaleorCustomerEventUserFragment = { readonly id: string, readonly email: string, readonly firstName: string, readonly lastName: string, readonly isActive: boolean, readonly isConfirmed: boolean, readonly languageCode: LanguageCodeEnum, readonly dateJoined: string, readonly updatedAt: string, readonly metadata: ReadonlyArray<{ readonly key: string, readonly value: string }>, readonly privateMetadata: ReadonlyArray<{ readonly key: string, readonly value: string }> };

export type FiefCustomerBulkUpdateMutationVariables = Exact<{
  customers: ReadonlyArray<CustomerBulkUpdateInput> | CustomerBulkUpdateInput;
  errorPolicy?: InputMaybe<ErrorPolicyEnum>;
}>;


export type FiefCustomerBulkUpdateMutation = { readonly customerBulkUpdate?: { readonly count: number, readonly results: ReadonlyArray<{ readonly customer?: { readonly id: string, readonly email: string, readonly firstName: string, readonly lastName: string, readonly isActive: boolean, readonly metadata: ReadonlyArray<{ readonly key: string, readonly value: string }>, readonly privateMetadata: ReadonlyArray<{ readonly key: string, readonly value: string }> } | null, readonly errors?: ReadonlyArray<{ readonly path?: string | null, readonly message?: string | null, readonly code: CustomerBulkUpdateErrorCode }> | null }>, readonly errors: ReadonlyArray<{ readonly path?: string | null, readonly message?: string | null, readonly code: CustomerBulkUpdateErrorCode }> } | null };

export type FiefCustomerCreateMutationVariables = Exact<{
  input: UserCreateInput;
}>;


export type FiefCustomerCreateMutation = { readonly customerCreate?: { readonly user?: { readonly id: string, readonly email: string, readonly firstName: string, readonly lastName: string, readonly isActive: boolean, readonly metadata: ReadonlyArray<{ readonly key: string, readonly value: string }>, readonly privateMetadata: ReadonlyArray<{ readonly key: string, readonly value: string }> } | null, readonly errors: ReadonlyArray<{ readonly field?: string | null, readonly message?: string | null, readonly code: AccountErrorCode }> } | null };

export type FiefCustomerUpdateMutationVariables = Exact<{
  id: Scalars['ID']['input'];
  input: CustomerInput;
}>;


export type FiefCustomerUpdateMutation = { readonly customerUpdate?: { readonly user?: { readonly id: string, readonly email: string, readonly firstName: string, readonly lastName: string, readonly isActive: boolean, readonly metadata: ReadonlyArray<{ readonly key: string, readonly value: string }>, readonly privateMetadata: ReadonlyArray<{ readonly key: string, readonly value: string }> } | null, readonly errors: ReadonlyArray<{ readonly field?: string | null, readonly message?: string | null, readonly code: AccountErrorCode }> } | null };

export type FiefUpdateMetadataMutationVariables = Exact<{
  id: Scalars['ID']['input'];
  input: ReadonlyArray<MetadataInput> | MetadataInput;
}>;


export type FiefUpdateMetadataMutation = { readonly updateMetadata?: { readonly item?: { readonly id: string, readonly email: string, readonly firstName: string, readonly lastName: string, readonly isActive: boolean, readonly metadata: ReadonlyArray<{ readonly key: string, readonly value: string }>, readonly privateMetadata: ReadonlyArray<{ readonly key: string, readonly value: string }> } | {} | null, readonly errors: ReadonlyArray<{ readonly field?: string | null, readonly message?: string | null, readonly code: MetadataErrorCode }> } | null };

export type FiefUpdatePrivateMetadataMutationVariables = Exact<{
  id: Scalars['ID']['input'];
  input: ReadonlyArray<MetadataInput> | MetadataInput;
}>;


export type FiefUpdatePrivateMetadataMutation = { readonly updatePrivateMetadata?: { readonly item?: { readonly id: string, readonly email: string, readonly firstName: string, readonly lastName: string, readonly isActive: boolean, readonly metadata: ReadonlyArray<{ readonly key: string, readonly value: string }>, readonly privateMetadata: ReadonlyArray<{ readonly key: string, readonly value: string }> } | {} | null, readonly errors: ReadonlyArray<{ readonly field?: string | null, readonly message?: string | null, readonly code: MetadataErrorCode }> } | null };

export type FiefCustomersListPageQueryVariables = Exact<{
  first: Scalars['Int']['input'];
  after?: InputMaybe<Scalars['String']['input']>;
}>;


export type FiefCustomersListPageQuery = { readonly customers?: { readonly pageInfo: { readonly hasNextPage: boolean, readonly endCursor?: string | null }, readonly edges: ReadonlyArray<{ readonly node: { readonly id: string, readonly email: string, readonly firstName: string, readonly lastName: string, readonly isActive: boolean, readonly metadata: ReadonlyArray<{ readonly key: string, readonly value: string }>, readonly privateMetadata: ReadonlyArray<{ readonly key: string, readonly value: string }> } }> } | null };

export type FiefMeQueryVariables = Exact<{ [key: string]: never; }>;


export type FiefMeQuery = { readonly me?: { readonly id: string, readonly email: string, readonly firstName: string, readonly lastName: string, readonly isActive: boolean, readonly metadata: ReadonlyArray<{ readonly key: string, readonly value: string }>, readonly privateMetadata: ReadonlyArray<{ readonly key: string, readonly value: string }> } | null };

export type FiefUserQueryVariables = Exact<{
  id?: InputMaybe<Scalars['ID']['input']>;
  email?: InputMaybe<Scalars['String']['input']>;
  externalReference?: InputMaybe<Scalars['String']['input']>;
}>;


export type FiefUserQuery = { readonly user?: { readonly id: string, readonly email: string, readonly firstName: string, readonly lastName: string, readonly isActive: boolean, readonly metadata: ReadonlyArray<{ readonly key: string, readonly value: string }>, readonly privateMetadata: ReadonlyArray<{ readonly key: string, readonly value: string }> } | null };

export type FiefCustomerCreatedEventFragment = { readonly version?: string | null, readonly user?: { readonly id: string, readonly email: string, readonly firstName: string, readonly lastName: string, readonly isActive: boolean, readonly isConfirmed: boolean, readonly languageCode: LanguageCodeEnum, readonly dateJoined: string, readonly updatedAt: string, readonly metadata: ReadonlyArray<{ readonly key: string, readonly value: string }>, readonly privateMetadata: ReadonlyArray<{ readonly key: string, readonly value: string }> } | null };

export type FiefCustomerCreatedSubscriptionVariables = Exact<{ [key: string]: never; }>;


export type FiefCustomerCreatedSubscription = { readonly event?: { readonly version?: string | null, readonly user?: { readonly id: string, readonly email: string, readonly firstName: string, readonly lastName: string, readonly isActive: boolean, readonly isConfirmed: boolean, readonly languageCode: LanguageCodeEnum, readonly dateJoined: string, readonly updatedAt: string, readonly metadata: ReadonlyArray<{ readonly key: string, readonly value: string }>, readonly privateMetadata: ReadonlyArray<{ readonly key: string, readonly value: string }> } | null } | {} | null };

export type FiefCustomerDeletedEventFragment = { readonly version?: string | null, readonly user?: { readonly id: string, readonly email: string, readonly firstName: string, readonly lastName: string, readonly isActive: boolean, readonly isConfirmed: boolean, readonly languageCode: LanguageCodeEnum, readonly dateJoined: string, readonly updatedAt: string, readonly metadata: ReadonlyArray<{ readonly key: string, readonly value: string }>, readonly privateMetadata: ReadonlyArray<{ readonly key: string, readonly value: string }> } | null };

export type FiefCustomerDeletedSubscriptionVariables = Exact<{ [key: string]: never; }>;


export type FiefCustomerDeletedSubscription = { readonly event?: { readonly version?: string | null, readonly user?: { readonly id: string, readonly email: string, readonly firstName: string, readonly lastName: string, readonly isActive: boolean, readonly isConfirmed: boolean, readonly languageCode: LanguageCodeEnum, readonly dateJoined: string, readonly updatedAt: string, readonly metadata: ReadonlyArray<{ readonly key: string, readonly value: string }>, readonly privateMetadata: ReadonlyArray<{ readonly key: string, readonly value: string }> } | null } | {} | null };

export type FiefCustomerUpdatedEventFragment = { readonly version?: string | null, readonly user?: { readonly id: string, readonly email: string, readonly firstName: string, readonly lastName: string, readonly isActive: boolean, readonly isConfirmed: boolean, readonly languageCode: LanguageCodeEnum, readonly dateJoined: string, readonly updatedAt: string, readonly metadata: ReadonlyArray<{ readonly key: string, readonly value: string }>, readonly privateMetadata: ReadonlyArray<{ readonly key: string, readonly value: string }> } | null };

export type FiefCustomerUpdatedSubscriptionVariables = Exact<{ [key: string]: never; }>;


export type FiefCustomerUpdatedSubscription = { readonly event?: { readonly version?: string | null, readonly user?: { readonly id: string, readonly email: string, readonly firstName: string, readonly lastName: string, readonly isActive: boolean, readonly isConfirmed: boolean, readonly languageCode: LanguageCodeEnum, readonly dateJoined: string, readonly updatedAt: string, readonly metadata: ReadonlyArray<{ readonly key: string, readonly value: string }>, readonly privateMetadata: ReadonlyArray<{ readonly key: string, readonly value: string }> } | null } | {} | null };

export const UntypedAccountErrorFragmentDoc = gql`
    fragment AccountError on AccountError {
  field
  message
  code
}
    `;
export const UntypedCustomerBulkUpdateErrorFragmentDoc = gql`
    fragment CustomerBulkUpdateError on CustomerBulkUpdateError {
  path
  message
  code
}
    `;
export const UntypedFiefCustomerFragmentDoc = gql`
    fragment FiefCustomer on User {
  id
  email
  firstName
  lastName
  isActive
  metadata {
    key
    value
  }
  privateMetadata {
    key
    value
  }
}
    `;
export const UntypedMetadataErrorFragmentDoc = gql`
    fragment MetadataError on MetadataError {
  field
  message
  code
}
    `;
export const UntypedSaleorCustomerEventUserFragmentDoc = gql`
    fragment SaleorCustomerEventUser on User {
  id
  email
  firstName
  lastName
  isActive
  isConfirmed
  languageCode
  dateJoined
  updatedAt
  metadata {
    key
    value
  }
  privateMetadata {
    key
    value
  }
}
    `;
export const UntypedFiefCustomerCreatedEventFragmentDoc = gql`
    fragment FiefCustomerCreatedEvent on CustomerCreated {
  version
  user {
    ...SaleorCustomerEventUser
  }
}
    `;
export const UntypedFiefCustomerDeletedEventFragmentDoc = gql`
    fragment FiefCustomerDeletedEvent on CustomerDeleted {
  version
  user {
    ...SaleorCustomerEventUser
  }
}
    `;
export const UntypedFiefCustomerUpdatedEventFragmentDoc = gql`
    fragment FiefCustomerUpdatedEvent on CustomerUpdated {
  version
  user {
    ...SaleorCustomerEventUser
  }
}
    `;
export const UntypedFiefCustomerBulkUpdateDocument = gql`
    mutation FiefCustomerBulkUpdate($customers: [CustomerBulkUpdateInput!]!, $errorPolicy: ErrorPolicyEnum) {
  customerBulkUpdate(customers: $customers, errorPolicy: $errorPolicy) {
    count
    results {
      customer {
        ...FiefCustomer
      }
      errors {
        ...CustomerBulkUpdateError
      }
    }
    errors {
      ...CustomerBulkUpdateError
    }
  }
}
    ${UntypedFiefCustomerFragmentDoc}
${UntypedCustomerBulkUpdateErrorFragmentDoc}`;
export const UntypedFiefCustomerCreateDocument = gql`
    mutation FiefCustomerCreate($input: UserCreateInput!) {
  customerCreate(input: $input) {
    user {
      ...FiefCustomer
    }
    errors {
      ...AccountError
    }
  }
}
    ${UntypedFiefCustomerFragmentDoc}
${UntypedAccountErrorFragmentDoc}`;
export const UntypedFiefCustomerUpdateDocument = gql`
    mutation FiefCustomerUpdate($id: ID!, $input: CustomerInput!) {
  customerUpdate(id: $id, input: $input) {
    user {
      ...FiefCustomer
    }
    errors {
      ...AccountError
    }
  }
}
    ${UntypedFiefCustomerFragmentDoc}
${UntypedAccountErrorFragmentDoc}`;
export const UntypedFiefUpdateMetadataDocument = gql`
    mutation FiefUpdateMetadata($id: ID!, $input: [MetadataInput!]!) {
  updateMetadata(id: $id, input: $input) {
    item {
      ... on User {
        ...FiefCustomer
      }
    }
    errors {
      ...MetadataError
    }
  }
}
    ${UntypedFiefCustomerFragmentDoc}
${UntypedMetadataErrorFragmentDoc}`;
export const UntypedFiefUpdatePrivateMetadataDocument = gql`
    mutation FiefUpdatePrivateMetadata($id: ID!, $input: [MetadataInput!]!) {
  updatePrivateMetadata(id: $id, input: $input) {
    item {
      ... on User {
        ...FiefCustomer
      }
    }
    errors {
      ...MetadataError
    }
  }
}
    ${UntypedFiefCustomerFragmentDoc}
${UntypedMetadataErrorFragmentDoc}`;
export const UntypedFiefCustomersListPageDocument = gql`
    query FiefCustomersListPage($first: Int!, $after: String) {
  customers(first: $first, after: $after) {
    pageInfo {
      hasNextPage
      endCursor
    }
    edges {
      node {
        ...FiefCustomer
      }
    }
  }
}
    ${UntypedFiefCustomerFragmentDoc}`;
export const UntypedFiefMeDocument = gql`
    query FiefMe {
  me {
    ...FiefCustomer
  }
}
    ${UntypedFiefCustomerFragmentDoc}`;
export const UntypedFiefUserDocument = gql`
    query FiefUser($id: ID, $email: String, $externalReference: String) {
  user(id: $id, email: $email, externalReference: $externalReference) {
    ...FiefCustomer
  }
}
    ${UntypedFiefCustomerFragmentDoc}`;
export const UntypedFiefCustomerCreatedDocument = gql`
    subscription FiefCustomerCreated {
  event {
    ...FiefCustomerCreatedEvent
  }
}
    ${UntypedFiefCustomerCreatedEventFragmentDoc}
${UntypedSaleorCustomerEventUserFragmentDoc}`;
export const UntypedFiefCustomerDeletedDocument = gql`
    subscription FiefCustomerDeleted {
  event {
    ...FiefCustomerDeletedEvent
  }
}
    ${UntypedFiefCustomerDeletedEventFragmentDoc}
${UntypedSaleorCustomerEventUserFragmentDoc}`;
export const UntypedFiefCustomerUpdatedDocument = gql`
    subscription FiefCustomerUpdated {
  event {
    ...FiefCustomerUpdatedEvent
  }
}
    ${UntypedFiefCustomerUpdatedEventFragmentDoc}
${UntypedSaleorCustomerEventUserFragmentDoc}`;
export const AccountErrorFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"AccountError"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"AccountError"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"field"}},{"kind":"Field","name":{"kind":"Name","value":"message"}},{"kind":"Field","name":{"kind":"Name","value":"code"}}]}}]} as unknown as DocumentNode<AccountErrorFragment, unknown>;
export const CustomerBulkUpdateErrorFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"CustomerBulkUpdateError"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"CustomerBulkUpdateError"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"path"}},{"kind":"Field","name":{"kind":"Name","value":"message"}},{"kind":"Field","name":{"kind":"Name","value":"code"}}]}}]} as unknown as DocumentNode<CustomerBulkUpdateErrorFragment, unknown>;
export const FiefCustomerFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"FiefCustomer"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"User"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"email"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"isActive"}},{"kind":"Field","name":{"kind":"Name","value":"metadata"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"key"}},{"kind":"Field","name":{"kind":"Name","value":"value"}}]}},{"kind":"Field","name":{"kind":"Name","value":"privateMetadata"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"key"}},{"kind":"Field","name":{"kind":"Name","value":"value"}}]}}]}}]} as unknown as DocumentNode<FiefCustomerFragment, unknown>;
export const MetadataErrorFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"MetadataError"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"MetadataError"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"field"}},{"kind":"Field","name":{"kind":"Name","value":"message"}},{"kind":"Field","name":{"kind":"Name","value":"code"}}]}}]} as unknown as DocumentNode<MetadataErrorFragment, unknown>;
export const SaleorCustomerEventUserFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"SaleorCustomerEventUser"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"User"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"email"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"isActive"}},{"kind":"Field","name":{"kind":"Name","value":"isConfirmed"}},{"kind":"Field","name":{"kind":"Name","value":"languageCode"}},{"kind":"Field","name":{"kind":"Name","value":"dateJoined"}},{"kind":"Field","name":{"kind":"Name","value":"updatedAt"}},{"kind":"Field","name":{"kind":"Name","value":"metadata"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"key"}},{"kind":"Field","name":{"kind":"Name","value":"value"}}]}},{"kind":"Field","name":{"kind":"Name","value":"privateMetadata"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"key"}},{"kind":"Field","name":{"kind":"Name","value":"value"}}]}}]}}]} as unknown as DocumentNode<SaleorCustomerEventUserFragment, unknown>;
export const FiefCustomerCreatedEventFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"FiefCustomerCreatedEvent"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"CustomerCreated"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"version"}},{"kind":"Field","name":{"kind":"Name","value":"user"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"SaleorCustomerEventUser"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"SaleorCustomerEventUser"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"User"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"email"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"isActive"}},{"kind":"Field","name":{"kind":"Name","value":"isConfirmed"}},{"kind":"Field","name":{"kind":"Name","value":"languageCode"}},{"kind":"Field","name":{"kind":"Name","value":"dateJoined"}},{"kind":"Field","name":{"kind":"Name","value":"updatedAt"}},{"kind":"Field","name":{"kind":"Name","value":"metadata"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"key"}},{"kind":"Field","name":{"kind":"Name","value":"value"}}]}},{"kind":"Field","name":{"kind":"Name","value":"privateMetadata"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"key"}},{"kind":"Field","name":{"kind":"Name","value":"value"}}]}}]}}]} as unknown as DocumentNode<FiefCustomerCreatedEventFragment, unknown>;
export const FiefCustomerDeletedEventFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"FiefCustomerDeletedEvent"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"CustomerDeleted"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"version"}},{"kind":"Field","name":{"kind":"Name","value":"user"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"SaleorCustomerEventUser"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"SaleorCustomerEventUser"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"User"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"email"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"isActive"}},{"kind":"Field","name":{"kind":"Name","value":"isConfirmed"}},{"kind":"Field","name":{"kind":"Name","value":"languageCode"}},{"kind":"Field","name":{"kind":"Name","value":"dateJoined"}},{"kind":"Field","name":{"kind":"Name","value":"updatedAt"}},{"kind":"Field","name":{"kind":"Name","value":"metadata"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"key"}},{"kind":"Field","name":{"kind":"Name","value":"value"}}]}},{"kind":"Field","name":{"kind":"Name","value":"privateMetadata"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"key"}},{"kind":"Field","name":{"kind":"Name","value":"value"}}]}}]}}]} as unknown as DocumentNode<FiefCustomerDeletedEventFragment, unknown>;
export const FiefCustomerUpdatedEventFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"FiefCustomerUpdatedEvent"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"CustomerUpdated"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"version"}},{"kind":"Field","name":{"kind":"Name","value":"user"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"SaleorCustomerEventUser"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"SaleorCustomerEventUser"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"User"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"email"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"isActive"}},{"kind":"Field","name":{"kind":"Name","value":"isConfirmed"}},{"kind":"Field","name":{"kind":"Name","value":"languageCode"}},{"kind":"Field","name":{"kind":"Name","value":"dateJoined"}},{"kind":"Field","name":{"kind":"Name","value":"updatedAt"}},{"kind":"Field","name":{"kind":"Name","value":"metadata"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"key"}},{"kind":"Field","name":{"kind":"Name","value":"value"}}]}},{"kind":"Field","name":{"kind":"Name","value":"privateMetadata"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"key"}},{"kind":"Field","name":{"kind":"Name","value":"value"}}]}}]}}]} as unknown as DocumentNode<FiefCustomerUpdatedEventFragment, unknown>;
export const FiefCustomerBulkUpdateDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"FiefCustomerBulkUpdate"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"customers"}},"type":{"kind":"NonNullType","type":{"kind":"ListType","type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"CustomerBulkUpdateInput"}}}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"errorPolicy"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"ErrorPolicyEnum"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"customerBulkUpdate"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"customers"},"value":{"kind":"Variable","name":{"kind":"Name","value":"customers"}}},{"kind":"Argument","name":{"kind":"Name","value":"errorPolicy"},"value":{"kind":"Variable","name":{"kind":"Name","value":"errorPolicy"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"count"}},{"kind":"Field","name":{"kind":"Name","value":"results"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"customer"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"FiefCustomer"}}]}},{"kind":"Field","name":{"kind":"Name","value":"errors"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"CustomerBulkUpdateError"}}]}}]}},{"kind":"Field","name":{"kind":"Name","value":"errors"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"CustomerBulkUpdateError"}}]}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"FiefCustomer"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"User"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"email"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"isActive"}},{"kind":"Field","name":{"kind":"Name","value":"metadata"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"key"}},{"kind":"Field","name":{"kind":"Name","value":"value"}}]}},{"kind":"Field","name":{"kind":"Name","value":"privateMetadata"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"key"}},{"kind":"Field","name":{"kind":"Name","value":"value"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"CustomerBulkUpdateError"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"CustomerBulkUpdateError"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"path"}},{"kind":"Field","name":{"kind":"Name","value":"message"}},{"kind":"Field","name":{"kind":"Name","value":"code"}}]}}]} as unknown as DocumentNode<FiefCustomerBulkUpdateMutation, FiefCustomerBulkUpdateMutationVariables>;
export const FiefCustomerCreateDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"FiefCustomerCreate"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"UserCreateInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"customerCreate"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"user"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"FiefCustomer"}}]}},{"kind":"Field","name":{"kind":"Name","value":"errors"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"AccountError"}}]}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"FiefCustomer"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"User"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"email"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"isActive"}},{"kind":"Field","name":{"kind":"Name","value":"metadata"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"key"}},{"kind":"Field","name":{"kind":"Name","value":"value"}}]}},{"kind":"Field","name":{"kind":"Name","value":"privateMetadata"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"key"}},{"kind":"Field","name":{"kind":"Name","value":"value"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"AccountError"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"AccountError"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"field"}},{"kind":"Field","name":{"kind":"Name","value":"message"}},{"kind":"Field","name":{"kind":"Name","value":"code"}}]}}]} as unknown as DocumentNode<FiefCustomerCreateMutation, FiefCustomerCreateMutationVariables>;
export const FiefCustomerUpdateDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"FiefCustomerUpdate"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"CustomerInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"customerUpdate"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}},{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"user"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"FiefCustomer"}}]}},{"kind":"Field","name":{"kind":"Name","value":"errors"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"AccountError"}}]}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"FiefCustomer"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"User"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"email"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"isActive"}},{"kind":"Field","name":{"kind":"Name","value":"metadata"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"key"}},{"kind":"Field","name":{"kind":"Name","value":"value"}}]}},{"kind":"Field","name":{"kind":"Name","value":"privateMetadata"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"key"}},{"kind":"Field","name":{"kind":"Name","value":"value"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"AccountError"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"AccountError"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"field"}},{"kind":"Field","name":{"kind":"Name","value":"message"}},{"kind":"Field","name":{"kind":"Name","value":"code"}}]}}]} as unknown as DocumentNode<FiefCustomerUpdateMutation, FiefCustomerUpdateMutationVariables>;
export const FiefUpdateMetadataDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"FiefUpdateMetadata"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"ListType","type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"MetadataInput"}}}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"updateMetadata"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}},{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"item"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"User"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"FiefCustomer"}}]}}]}},{"kind":"Field","name":{"kind":"Name","value":"errors"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"MetadataError"}}]}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"FiefCustomer"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"User"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"email"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"isActive"}},{"kind":"Field","name":{"kind":"Name","value":"metadata"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"key"}},{"kind":"Field","name":{"kind":"Name","value":"value"}}]}},{"kind":"Field","name":{"kind":"Name","value":"privateMetadata"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"key"}},{"kind":"Field","name":{"kind":"Name","value":"value"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"MetadataError"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"MetadataError"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"field"}},{"kind":"Field","name":{"kind":"Name","value":"message"}},{"kind":"Field","name":{"kind":"Name","value":"code"}}]}}]} as unknown as DocumentNode<FiefUpdateMetadataMutation, FiefUpdateMetadataMutationVariables>;
export const FiefUpdatePrivateMetadataDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"FiefUpdatePrivateMetadata"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"ListType","type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"MetadataInput"}}}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"updatePrivateMetadata"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}},{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"item"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"User"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"FiefCustomer"}}]}}]}},{"kind":"Field","name":{"kind":"Name","value":"errors"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"MetadataError"}}]}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"FiefCustomer"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"User"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"email"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"isActive"}},{"kind":"Field","name":{"kind":"Name","value":"metadata"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"key"}},{"kind":"Field","name":{"kind":"Name","value":"value"}}]}},{"kind":"Field","name":{"kind":"Name","value":"privateMetadata"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"key"}},{"kind":"Field","name":{"kind":"Name","value":"value"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"MetadataError"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"MetadataError"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"field"}},{"kind":"Field","name":{"kind":"Name","value":"message"}},{"kind":"Field","name":{"kind":"Name","value":"code"}}]}}]} as unknown as DocumentNode<FiefUpdatePrivateMetadataMutation, FiefUpdatePrivateMetadataMutationVariables>;
export const FiefCustomersListPageDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"FiefCustomersListPage"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"first"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"Int"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"after"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"customers"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"first"},"value":{"kind":"Variable","name":{"kind":"Name","value":"first"}}},{"kind":"Argument","name":{"kind":"Name","value":"after"},"value":{"kind":"Variable","name":{"kind":"Name","value":"after"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"pageInfo"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"hasNextPage"}},{"kind":"Field","name":{"kind":"Name","value":"endCursor"}}]}},{"kind":"Field","name":{"kind":"Name","value":"edges"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"node"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"FiefCustomer"}}]}}]}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"FiefCustomer"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"User"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"email"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"isActive"}},{"kind":"Field","name":{"kind":"Name","value":"metadata"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"key"}},{"kind":"Field","name":{"kind":"Name","value":"value"}}]}},{"kind":"Field","name":{"kind":"Name","value":"privateMetadata"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"key"}},{"kind":"Field","name":{"kind":"Name","value":"value"}}]}}]}}]} as unknown as DocumentNode<FiefCustomersListPageQuery, FiefCustomersListPageQueryVariables>;
export const FiefMeDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"FiefMe"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"me"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"FiefCustomer"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"FiefCustomer"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"User"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"email"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"isActive"}},{"kind":"Field","name":{"kind":"Name","value":"metadata"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"key"}},{"kind":"Field","name":{"kind":"Name","value":"value"}}]}},{"kind":"Field","name":{"kind":"Name","value":"privateMetadata"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"key"}},{"kind":"Field","name":{"kind":"Name","value":"value"}}]}}]}}]} as unknown as DocumentNode<FiefMeQuery, FiefMeQueryVariables>;
export const FiefUserDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"FiefUser"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"email"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"externalReference"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"user"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}},{"kind":"Argument","name":{"kind":"Name","value":"email"},"value":{"kind":"Variable","name":{"kind":"Name","value":"email"}}},{"kind":"Argument","name":{"kind":"Name","value":"externalReference"},"value":{"kind":"Variable","name":{"kind":"Name","value":"externalReference"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"FiefCustomer"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"FiefCustomer"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"User"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"email"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"isActive"}},{"kind":"Field","name":{"kind":"Name","value":"metadata"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"key"}},{"kind":"Field","name":{"kind":"Name","value":"value"}}]}},{"kind":"Field","name":{"kind":"Name","value":"privateMetadata"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"key"}},{"kind":"Field","name":{"kind":"Name","value":"value"}}]}}]}}]} as unknown as DocumentNode<FiefUserQuery, FiefUserQueryVariables>;
export const FiefCustomerCreatedDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"subscription","name":{"kind":"Name","value":"FiefCustomerCreated"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"event"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"FiefCustomerCreatedEvent"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"SaleorCustomerEventUser"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"User"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"email"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"isActive"}},{"kind":"Field","name":{"kind":"Name","value":"isConfirmed"}},{"kind":"Field","name":{"kind":"Name","value":"languageCode"}},{"kind":"Field","name":{"kind":"Name","value":"dateJoined"}},{"kind":"Field","name":{"kind":"Name","value":"updatedAt"}},{"kind":"Field","name":{"kind":"Name","value":"metadata"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"key"}},{"kind":"Field","name":{"kind":"Name","value":"value"}}]}},{"kind":"Field","name":{"kind":"Name","value":"privateMetadata"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"key"}},{"kind":"Field","name":{"kind":"Name","value":"value"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"FiefCustomerCreatedEvent"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"CustomerCreated"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"version"}},{"kind":"Field","name":{"kind":"Name","value":"user"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"SaleorCustomerEventUser"}}]}}]}}]} as unknown as DocumentNode<FiefCustomerCreatedSubscription, FiefCustomerCreatedSubscriptionVariables>;
export const FiefCustomerDeletedDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"subscription","name":{"kind":"Name","value":"FiefCustomerDeleted"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"event"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"FiefCustomerDeletedEvent"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"SaleorCustomerEventUser"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"User"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"email"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"isActive"}},{"kind":"Field","name":{"kind":"Name","value":"isConfirmed"}},{"kind":"Field","name":{"kind":"Name","value":"languageCode"}},{"kind":"Field","name":{"kind":"Name","value":"dateJoined"}},{"kind":"Field","name":{"kind":"Name","value":"updatedAt"}},{"kind":"Field","name":{"kind":"Name","value":"metadata"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"key"}},{"kind":"Field","name":{"kind":"Name","value":"value"}}]}},{"kind":"Field","name":{"kind":"Name","value":"privateMetadata"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"key"}},{"kind":"Field","name":{"kind":"Name","value":"value"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"FiefCustomerDeletedEvent"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"CustomerDeleted"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"version"}},{"kind":"Field","name":{"kind":"Name","value":"user"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"SaleorCustomerEventUser"}}]}}]}}]} as unknown as DocumentNode<FiefCustomerDeletedSubscription, FiefCustomerDeletedSubscriptionVariables>;
export const FiefCustomerUpdatedDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"subscription","name":{"kind":"Name","value":"FiefCustomerUpdated"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"event"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"FiefCustomerUpdatedEvent"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"SaleorCustomerEventUser"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"User"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"email"}},{"kind":"Field","name":{"kind":"Name","value":"firstName"}},{"kind":"Field","name":{"kind":"Name","value":"lastName"}},{"kind":"Field","name":{"kind":"Name","value":"isActive"}},{"kind":"Field","name":{"kind":"Name","value":"isConfirmed"}},{"kind":"Field","name":{"kind":"Name","value":"languageCode"}},{"kind":"Field","name":{"kind":"Name","value":"dateJoined"}},{"kind":"Field","name":{"kind":"Name","value":"updatedAt"}},{"kind":"Field","name":{"kind":"Name","value":"metadata"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"key"}},{"kind":"Field","name":{"kind":"Name","value":"value"}}]}},{"kind":"Field","name":{"kind":"Name","value":"privateMetadata"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"key"}},{"kind":"Field","name":{"kind":"Name","value":"value"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"FiefCustomerUpdatedEvent"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"CustomerUpdated"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"version"}},{"kind":"Field","name":{"kind":"Name","value":"user"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"SaleorCustomerEventUser"}}]}}]}}]} as unknown as DocumentNode<FiefCustomerUpdatedSubscription, FiefCustomerUpdatedSubscriptionVariables>;