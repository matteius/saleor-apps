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

export type CardPaymentMethodDetailsInput = {
  /** Brand of the payment method used for the transaction. Max length is 40 characters. */
  readonly brand?: InputMaybe<Scalars['String']['input']>;
  /** Expiration month of the card used for the transaction. Value must be between 1 and 12. */
  readonly expMonth?: InputMaybe<Scalars['Int']['input']>;
  /** Expiration year of the card used for the transaction. Value must be between 2000 and 9999. */
  readonly expYear?: InputMaybe<Scalars['Int']['input']>;
  /** First digits of the card used for the transaction. Max length is 4 characters. */
  readonly firstDigits?: InputMaybe<Scalars['String']['input']>;
  /** Last digits of the card used for the transaction. Max length is 4 characters. */
  readonly lastDigits?: InputMaybe<Scalars['String']['input']>;
  /** Name of the payment method used for the transaction. Max length is 256 characters. */
  readonly name: Scalars['String']['input'];
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

export type DraftOrderCreateInput = {
  /** Billing address of the customer. */
  readonly billingAddress?: InputMaybe<AddressInput>;
  /** ID of the channel associated with the order. */
  readonly channelId?: InputMaybe<Scalars['ID']['input']>;
  /** A note from a customer. Visible by customers in the order summary. */
  readonly customerNote?: InputMaybe<Scalars['String']['input']>;
  /**
   * Discount amount for the order.
   * @deprecated Providing a value for the field has no effect. Use `orderDiscountAdd` mutation instead.
   */
  readonly discount?: InputMaybe<Scalars['PositiveDecimal']['input']>;
  /** External ID of this order. */
  readonly externalReference?: InputMaybe<Scalars['String']['input']>;
  /**
   * Order language code.
   *
   * Added in Saleor 3.21.
   */
  readonly languageCode?: InputMaybe<LanguageCodeEnum>;
  /** Variant line input consisting of variant ID and quantity of products. */
  readonly lines?: InputMaybe<ReadonlyArray<OrderLineCreateInput>>;
  /**
   * Order public metadata.
   *
   * Added in Saleor 3.21. Can be read by any API client authorized to read the object it's attached to.
   *
   * Warning: never store sensitive information, including financial data such as credit card details.
   */
  readonly metadata?: InputMaybe<ReadonlyArray<MetadataInput>>;
  /**
   * Order private metadata.
   *
   * Added in Saleor 3.21. Requires permissions to modify and to read the metadata of the object it's attached to.
   *
   * Warning: never store sensitive information, including financial data such as credit card details.
   */
  readonly privateMetadata?: InputMaybe<ReadonlyArray<MetadataInput>>;
  /** URL of a view where users should be redirected to see the order details. URL in RFC 1808 format. */
  readonly redirectUrl?: InputMaybe<Scalars['String']['input']>;
  /**
   * Indicates whether the billing address should be saved to the user’s address book upon draft order completion. Can only be set when a billing address is provided. If not specified along with the address, the default behavior is to not save the address.
   *
   * Added in Saleor 3.21.
   */
  readonly saveBillingAddress?: InputMaybe<Scalars['Boolean']['input']>;
  /**
   * Indicates whether the shipping address should be saved to the user’s address book upon draft order completion.Can only be set when a shipping address is provided. If not specified along with the address, the default behavior is to not save the address.
   *
   * Added in Saleor 3.21.
   */
  readonly saveShippingAddress?: InputMaybe<Scalars['Boolean']['input']>;
  /** Shipping address of the customer. */
  readonly shippingAddress?: InputMaybe<AddressInput>;
  /** ID of a selected shipping method. */
  readonly shippingMethod?: InputMaybe<Scalars['ID']['input']>;
  /** Customer associated with the draft order. */
  readonly user?: InputMaybe<Scalars['ID']['input']>;
  /** Email address of the customer. */
  readonly userEmail?: InputMaybe<Scalars['String']['input']>;
  /**
   * ID of the voucher associated with the order.
   * @deprecated Use `voucherCode` instead.
   */
  readonly voucher?: InputMaybe<Scalars['ID']['input']>;
  /**
   * A code of the voucher associated with the order.
   *
   * Added in Saleor 3.18.
   */
  readonly voucherCode?: InputMaybe<Scalars['String']['input']>;
};

export type GiftCardPaymentMethodDetailsInput = {
  /**
   * Brand of the gift card used for the transaction. Max length is 40 characters.
   *
   * Added in Saleor 3.23.
   */
  readonly brand?: InputMaybe<Scalars['String']['input']>;
  /**
   * Last characters of the gift card used for the transaction. Max length is 4 characters.
   *
   * Added in Saleor 3.23.
   */
  readonly lastChars?: InputMaybe<Scalars['String']['input']>;
  /**
   * Name of the payment method used for the transaction. Max length is 256 characters.
   *
   * Added in Saleor 3.23.
   */
  readonly name: Scalars['String']['input'];
};

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

export type MetadataInput = {
  /** Key of a metadata item. */
  readonly key: Scalars['String']['input'];
  /** Value of a metadata item. */
  readonly value: Scalars['String']['input'];
};

export type MoneyInput = {
  /** Amount of money. */
  readonly amount: Scalars['PositiveDecimal']['input'];
  /** Currency code. */
  readonly currency: Scalars['String']['input'];
};

export type OrderErrorCode =
  | 'BILLING_ADDRESS_NOT_SET'
  | 'CANNOT_CANCEL_FULFILLMENT'
  | 'CANNOT_CANCEL_ORDER'
  | 'CANNOT_DELETE'
  | 'CANNOT_DISCOUNT'
  | 'CANNOT_FULFILL_UNPAID_ORDER'
  | 'CANNOT_REFUND'
  | 'CAPTURE_INACTIVE_PAYMENT'
  | 'CHANNEL_INACTIVE'
  | 'DUPLICATED_INPUT_ITEM'
  | 'FULFILL_ORDER_LINE'
  | 'GIFT_CARD_LINE'
  | 'GRAPHQL_ERROR'
  | 'INSUFFICIENT_STOCK'
  | 'INVALID'
  | 'INVALID_QUANTITY'
  | 'INVALID_VOUCHER'
  | 'INVALID_VOUCHER_CODE'
  | 'MISSING_ADDRESS_DATA'
  | 'NON_EDITABLE_GIFT_LINE'
  | 'NON_REMOVABLE_GIFT_LINE'
  | 'NOT_AVAILABLE_IN_CHANNEL'
  | 'NOT_EDITABLE'
  | 'NOT_FOUND'
  | 'ORDER_NO_SHIPPING_ADDRESS'
  | 'PAYMENT_ERROR'
  | 'PAYMENT_MISSING'
  | 'PRODUCT_NOT_PUBLISHED'
  | 'PRODUCT_UNAVAILABLE_FOR_PURCHASE'
  | 'REQUIRED'
  | 'SHIPPING_METHOD_NOT_APPLICABLE'
  | 'SHIPPING_METHOD_REQUIRED'
  | 'TAX_ERROR'
  | 'TRANSACTION_ERROR'
  | 'UNIQUE'
  | 'VOID_INACTIVE_PAYMENT'
  | 'ZERO_QUANTITY';

export type OrderLineCreateInput = {
  /** Flag that allow force splitting the same variant into multiple lines by skipping the matching logic. */
  readonly forceNewLine?: InputMaybe<Scalars['Boolean']['input']>;
  /** Custom price of the item.When the line with the same variant will be provided multiple times, the last price will be used. */
  readonly price?: InputMaybe<Scalars['PositiveDecimal']['input']>;
  /** Number of variant items ordered. */
  readonly quantity: Scalars['Int']['input'];
  /** Product variant ID. */
  readonly variantId: Scalars['ID']['input'];
};

export type OtherPaymentMethodDetailsInput = {
  /** Name of the payment method used for the transaction. */
  readonly name: Scalars['String']['input'];
};

/**
 * Details of the payment method used for the transaction. One of `card`, `other`, or `giftCard` is required.
 *
 * Added in Saleor 3.22.
 */
export type PaymentMethodDetailsInput = {
  /** Details of the card payment method used for the transaction. */
  readonly card?: InputMaybe<CardPaymentMethodDetailsInput>;
  /**
   * Details of the gift card payment method used for the transaction.
   *
   * Added in Saleor 3.23.
   */
  readonly giftCard?: InputMaybe<GiftCardPaymentMethodDetailsInput>;
  /** Details of the non-card payment method used for this transaction. */
  readonly other?: InputMaybe<OtherPaymentMethodDetailsInput>;
};

/**
 * Represents possible actions on payment transaction.
 *
 *     The following actions are possible:
 *     CHARGE - Represents the charge action.
 *     REFUND - Represents a refund action.
 *     CANCEL - Represents a cancel action. Added in Saleor 3.12.
 */
export type TransactionActionEnum =
  | 'CANCEL'
  | 'CHARGE'
  | 'REFUND';

export type TransactionCreateErrorCode =
  | 'GRAPHQL_ERROR'
  | 'INCORRECT_CURRENCY'
  | 'INVALID'
  | 'METADATA_KEY_REQUIRED'
  | 'NOT_FOUND'
  | 'UNIQUE';

export type TransactionCreateInput = {
  /** Amount authorized by this transaction. */
  readonly amountAuthorized?: InputMaybe<MoneyInput>;
  /** Amount canceled by this transaction. */
  readonly amountCanceled?: InputMaybe<MoneyInput>;
  /** Amount charged by this transaction. */
  readonly amountCharged?: InputMaybe<MoneyInput>;
  /** Amount refunded by this transaction. */
  readonly amountRefunded?: InputMaybe<MoneyInput>;
  /** List of all possible actions for the transaction */
  readonly availableActions?: InputMaybe<ReadonlyArray<TransactionActionEnum>>;
  /** The url that will allow to redirect user to payment provider page with transaction event details. */
  readonly externalUrl?: InputMaybe<Scalars['String']['input']>;
  /** The message of the transaction. */
  readonly message?: InputMaybe<Scalars['String']['input']>;
  /**
   * Payment public metadata. Can be read by any API client authorized to read the object it's attached to.
   *
   * Warning: never store sensitive information, including financial data such as credit card details.
   */
  readonly metadata?: InputMaybe<ReadonlyArray<MetadataInput>>;
  /** Payment name of the transaction. */
  readonly name?: InputMaybe<Scalars['String']['input']>;
  /**
   * Details of the payment method used for the transaction.
   *
   * Added in Saleor 3.22.
   */
  readonly paymentMethodDetails?: InputMaybe<PaymentMethodDetailsInput>;
  /**
   * Payment private metadata. Requires permissions to modify and to read the metadata of the object it's attached to.
   *
   * Warning: never store sensitive information, including financial data such as credit card details.
   */
  readonly privateMetadata?: InputMaybe<ReadonlyArray<MetadataInput>>;
  /** PSP Reference of the transaction. */
  readonly pspReference?: InputMaybe<Scalars['String']['input']>;
};

export type TransactionEventReportErrorCode =
  | 'ALREADY_EXISTS'
  | 'GRAPHQL_ERROR'
  | 'INCORRECT_DETAILS'
  | 'INVALID'
  | 'NOT_FOUND'
  | 'REQUIRED';

/**
 * Represents possible event types.
 *
 *     Added in Saleor 3.12.
 *
 *     The following types are possible:
 *     AUTHORIZATION_SUCCESS - represents success authorization.
 *     AUTHORIZATION_FAILURE - represents failure authorization.
 *     AUTHORIZATION_ADJUSTMENT - represents authorization adjustment.
 *     AUTHORIZATION_REQUEST - represents authorization request.
 *     AUTHORIZATION_ACTION_REQUIRED - represents authorization that needs
 *     additional actions from the customer.
 *     CHARGE_ACTION_REQUIRED - represents charge that needs
 *     additional actions from the customer.
 *     CHARGE_SUCCESS - represents success charge.
 *     CHARGE_FAILURE - represents failure charge.
 *     CHARGE_BACK - represents chargeback.
 *     CHARGE_REQUEST - represents charge request.
 *     REFUND_SUCCESS - represents success refund.
 *     REFUND_FAILURE - represents failure refund.
 *     REFUND_REVERSE - represents reverse refund.
 *     REFUND_REQUEST - represents refund request.
 *     CANCEL_SUCCESS - represents success cancel.
 *     CANCEL_FAILURE - represents failure cancel.
 *     CANCEL_REQUEST - represents cancel request.
 *     INFO - represents info event.
 */
export type TransactionEventTypeEnum =
  | 'AUTHORIZATION_ACTION_REQUIRED'
  | 'AUTHORIZATION_ADJUSTMENT'
  | 'AUTHORIZATION_FAILURE'
  | 'AUTHORIZATION_REQUEST'
  | 'AUTHORIZATION_SUCCESS'
  | 'CANCEL_FAILURE'
  | 'CANCEL_REQUEST'
  | 'CANCEL_SUCCESS'
  | 'CHARGE_ACTION_REQUIRED'
  | 'CHARGE_BACK'
  | 'CHARGE_FAILURE'
  | 'CHARGE_REQUEST'
  | 'CHARGE_SUCCESS'
  | 'INFO'
  | 'REFUND_FAILURE'
  | 'REFUND_REQUEST'
  | 'REFUND_REVERSE'
  | 'REFUND_SUCCESS';

/**
 * Determine the transaction flow strategy.
 *
 *     AUTHORIZATION - the processed transaction should be only authorized
 *     CHARGE - the processed transaction should be charged.
 */
export type TransactionFlowStrategyEnum =
  | 'AUTHORIZATION'
  | 'CHARGE';

export type ChannelFragment = { readonly id: string, readonly slug: string };

type EventMetadata_AccountChangeEmailRequested_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_AccountConfirmationRequested_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_AccountConfirmed_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_AccountDeleteRequested_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_AccountDeleted_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_AccountEmailChanged_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_AccountSetPasswordRequested_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_AddressCreated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_AddressDeleted_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_AddressUpdated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_AppDeleted_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_AppInstalled_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_AppStatusChanged_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_AppUpdated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_AttributeCreated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_AttributeDeleted_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_AttributeUpdated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_AttributeValueCreated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_AttributeValueDeleted_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_AttributeValueUpdated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_CalculateTaxes_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_CategoryCreated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_CategoryDeleted_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_CategoryUpdated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_ChannelCreated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_ChannelDeleted_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_ChannelMetadataUpdated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_ChannelStatusChanged_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_ChannelUpdated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_CheckoutCreated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_CheckoutFilterShippingMethods_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_CheckoutFullyAuthorized_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_CheckoutFullyPaid_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_CheckoutMetadataUpdated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_CheckoutUpdated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_CollectionCreated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_CollectionDeleted_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_CollectionMetadataUpdated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_CollectionUpdated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_CustomerCreated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_CustomerMetadataUpdated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_CustomerUpdated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_DraftOrderCreated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_DraftOrderDeleted_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_DraftOrderUpdated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_FulfillmentApproved_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_FulfillmentCanceled_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_FulfillmentCreated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_FulfillmentMetadataUpdated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_FulfillmentTrackingNumberUpdated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_GiftCardCreated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_GiftCardDeleted_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_GiftCardExportCompleted_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_GiftCardMetadataUpdated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_GiftCardSent_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_GiftCardStatusChanged_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_GiftCardUpdated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_InvoiceDeleted_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_InvoiceRequested_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_InvoiceSent_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_ListStoredPaymentMethods_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_MenuCreated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_MenuDeleted_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_MenuItemCreated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_MenuItemDeleted_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_MenuItemUpdated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_MenuUpdated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_OrderBulkCreated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_OrderCancelled_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_OrderConfirmed_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_OrderCreated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_OrderExpired_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_OrderFilterShippingMethods_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_OrderFulfilled_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_OrderFullyPaid_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_OrderFullyRefunded_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_OrderMetadataUpdated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_OrderPaid_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_OrderRefunded_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_OrderUpdated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_PageCreated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_PageDeleted_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_PageTypeCreated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_PageTypeDeleted_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_PageTypeUpdated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_PageUpdated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_PaymentAuthorize_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_PaymentCaptureEvent_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_PaymentConfirmEvent_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_PaymentGatewayInitializeSession_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_PaymentGatewayInitializeTokenizationSession_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_PaymentListGateways_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_PaymentMethodInitializeTokenizationSession_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_PaymentMethodProcessTokenizationSession_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_PaymentProcessEvent_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_PaymentRefundEvent_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_PaymentVoidEvent_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_PermissionGroupCreated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_PermissionGroupDeleted_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_PermissionGroupUpdated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_ProductCreated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_ProductDeleted_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_ProductExportCompleted_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_ProductMediaCreated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_ProductMediaDeleted_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_ProductMediaUpdated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_ProductMetadataUpdated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_ProductUpdated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_ProductVariantBackInStock_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_ProductVariantBackInStockForClickAndCollect_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_ProductVariantBackInStockInChannel_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_ProductVariantCreated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_ProductVariantDeleted_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_ProductVariantDiscountedPriceUpdated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_ProductVariantMetadataUpdated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_ProductVariantOutOfStock_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_ProductVariantOutOfStockForClickAndCollect_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_ProductVariantOutOfStockInChannel_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_ProductVariantStockUpdated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_ProductVariantUpdated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_PromotionCreated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_PromotionDeleted_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_PromotionEnded_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_PromotionRuleCreated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_PromotionRuleDeleted_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_PromotionRuleUpdated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_PromotionStarted_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_PromotionUpdated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_SaleCreated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_SaleDeleted_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_SaleToggle_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_SaleUpdated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_ShippingListMethodsForCheckout_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_ShippingPriceCreated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_ShippingPriceDeleted_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_ShippingPriceUpdated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_ShippingZoneCreated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_ShippingZoneDeleted_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_ShippingZoneMetadataUpdated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_ShippingZoneUpdated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_ShopMetadataUpdated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_StaffCreated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_StaffDeleted_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_StaffSetPasswordRequested_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_StaffUpdated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_StoredPaymentMethodDeleteRequested_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_ThumbnailCreated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_TransactionCancelationRequested_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_TransactionChargeRequested_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_TransactionInitializeSession_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_TransactionItemMetadataUpdated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_TransactionProcessSession_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_TransactionRefundRequested_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_TranslationCreated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_TranslationUpdated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_VoucherCodeExportCompleted_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_VoucherCodesCreated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_VoucherCodesDeleted_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_VoucherCreated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_VoucherDeleted_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_VoucherMetadataUpdated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_VoucherUpdated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_WarehouseCreated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_WarehouseDeleted_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_WarehouseMetadataUpdated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

type EventMetadata_WarehouseUpdated_Fragment = { readonly version?: string | null, readonly recipient?: { readonly id: string } | null };

export type EventMetadataFragment = EventMetadata_AccountChangeEmailRequested_Fragment | EventMetadata_AccountConfirmationRequested_Fragment | EventMetadata_AccountConfirmed_Fragment | EventMetadata_AccountDeleteRequested_Fragment | EventMetadata_AccountDeleted_Fragment | EventMetadata_AccountEmailChanged_Fragment | EventMetadata_AccountSetPasswordRequested_Fragment | EventMetadata_AddressCreated_Fragment | EventMetadata_AddressDeleted_Fragment | EventMetadata_AddressUpdated_Fragment | EventMetadata_AppDeleted_Fragment | EventMetadata_AppInstalled_Fragment | EventMetadata_AppStatusChanged_Fragment | EventMetadata_AppUpdated_Fragment | EventMetadata_AttributeCreated_Fragment | EventMetadata_AttributeDeleted_Fragment | EventMetadata_AttributeUpdated_Fragment | EventMetadata_AttributeValueCreated_Fragment | EventMetadata_AttributeValueDeleted_Fragment | EventMetadata_AttributeValueUpdated_Fragment | EventMetadata_CalculateTaxes_Fragment | EventMetadata_CategoryCreated_Fragment | EventMetadata_CategoryDeleted_Fragment | EventMetadata_CategoryUpdated_Fragment | EventMetadata_ChannelCreated_Fragment | EventMetadata_ChannelDeleted_Fragment | EventMetadata_ChannelMetadataUpdated_Fragment | EventMetadata_ChannelStatusChanged_Fragment | EventMetadata_ChannelUpdated_Fragment | EventMetadata_CheckoutCreated_Fragment | EventMetadata_CheckoutFilterShippingMethods_Fragment | EventMetadata_CheckoutFullyAuthorized_Fragment | EventMetadata_CheckoutFullyPaid_Fragment | EventMetadata_CheckoutMetadataUpdated_Fragment | EventMetadata_CheckoutUpdated_Fragment | EventMetadata_CollectionCreated_Fragment | EventMetadata_CollectionDeleted_Fragment | EventMetadata_CollectionMetadataUpdated_Fragment | EventMetadata_CollectionUpdated_Fragment | EventMetadata_CustomerCreated_Fragment | EventMetadata_CustomerMetadataUpdated_Fragment | EventMetadata_CustomerUpdated_Fragment | EventMetadata_DraftOrderCreated_Fragment | EventMetadata_DraftOrderDeleted_Fragment | EventMetadata_DraftOrderUpdated_Fragment | EventMetadata_FulfillmentApproved_Fragment | EventMetadata_FulfillmentCanceled_Fragment | EventMetadata_FulfillmentCreated_Fragment | EventMetadata_FulfillmentMetadataUpdated_Fragment | EventMetadata_FulfillmentTrackingNumberUpdated_Fragment | EventMetadata_GiftCardCreated_Fragment | EventMetadata_GiftCardDeleted_Fragment | EventMetadata_GiftCardExportCompleted_Fragment | EventMetadata_GiftCardMetadataUpdated_Fragment | EventMetadata_GiftCardSent_Fragment | EventMetadata_GiftCardStatusChanged_Fragment | EventMetadata_GiftCardUpdated_Fragment | EventMetadata_InvoiceDeleted_Fragment | EventMetadata_InvoiceRequested_Fragment | EventMetadata_InvoiceSent_Fragment | EventMetadata_ListStoredPaymentMethods_Fragment | EventMetadata_MenuCreated_Fragment | EventMetadata_MenuDeleted_Fragment | EventMetadata_MenuItemCreated_Fragment | EventMetadata_MenuItemDeleted_Fragment | EventMetadata_MenuItemUpdated_Fragment | EventMetadata_MenuUpdated_Fragment | EventMetadata_OrderBulkCreated_Fragment | EventMetadata_OrderCancelled_Fragment | EventMetadata_OrderConfirmed_Fragment | EventMetadata_OrderCreated_Fragment | EventMetadata_OrderExpired_Fragment | EventMetadata_OrderFilterShippingMethods_Fragment | EventMetadata_OrderFulfilled_Fragment | EventMetadata_OrderFullyPaid_Fragment | EventMetadata_OrderFullyRefunded_Fragment | EventMetadata_OrderMetadataUpdated_Fragment | EventMetadata_OrderPaid_Fragment | EventMetadata_OrderRefunded_Fragment | EventMetadata_OrderUpdated_Fragment | EventMetadata_PageCreated_Fragment | EventMetadata_PageDeleted_Fragment | EventMetadata_PageTypeCreated_Fragment | EventMetadata_PageTypeDeleted_Fragment | EventMetadata_PageTypeUpdated_Fragment | EventMetadata_PageUpdated_Fragment | EventMetadata_PaymentAuthorize_Fragment | EventMetadata_PaymentCaptureEvent_Fragment | EventMetadata_PaymentConfirmEvent_Fragment | EventMetadata_PaymentGatewayInitializeSession_Fragment | EventMetadata_PaymentGatewayInitializeTokenizationSession_Fragment | EventMetadata_PaymentListGateways_Fragment | EventMetadata_PaymentMethodInitializeTokenizationSession_Fragment | EventMetadata_PaymentMethodProcessTokenizationSession_Fragment | EventMetadata_PaymentProcessEvent_Fragment | EventMetadata_PaymentRefundEvent_Fragment | EventMetadata_PaymentVoidEvent_Fragment | EventMetadata_PermissionGroupCreated_Fragment | EventMetadata_PermissionGroupDeleted_Fragment | EventMetadata_PermissionGroupUpdated_Fragment | EventMetadata_ProductCreated_Fragment | EventMetadata_ProductDeleted_Fragment | EventMetadata_ProductExportCompleted_Fragment | EventMetadata_ProductMediaCreated_Fragment | EventMetadata_ProductMediaDeleted_Fragment | EventMetadata_ProductMediaUpdated_Fragment | EventMetadata_ProductMetadataUpdated_Fragment | EventMetadata_ProductUpdated_Fragment | EventMetadata_ProductVariantBackInStock_Fragment | EventMetadata_ProductVariantBackInStockForClickAndCollect_Fragment | EventMetadata_ProductVariantBackInStockInChannel_Fragment | EventMetadata_ProductVariantCreated_Fragment | EventMetadata_ProductVariantDeleted_Fragment | EventMetadata_ProductVariantDiscountedPriceUpdated_Fragment | EventMetadata_ProductVariantMetadataUpdated_Fragment | EventMetadata_ProductVariantOutOfStock_Fragment | EventMetadata_ProductVariantOutOfStockForClickAndCollect_Fragment | EventMetadata_ProductVariantOutOfStockInChannel_Fragment | EventMetadata_ProductVariantStockUpdated_Fragment | EventMetadata_ProductVariantUpdated_Fragment | EventMetadata_PromotionCreated_Fragment | EventMetadata_PromotionDeleted_Fragment | EventMetadata_PromotionEnded_Fragment | EventMetadata_PromotionRuleCreated_Fragment | EventMetadata_PromotionRuleDeleted_Fragment | EventMetadata_PromotionRuleUpdated_Fragment | EventMetadata_PromotionStarted_Fragment | EventMetadata_PromotionUpdated_Fragment | EventMetadata_SaleCreated_Fragment | EventMetadata_SaleDeleted_Fragment | EventMetadata_SaleToggle_Fragment | EventMetadata_SaleUpdated_Fragment | EventMetadata_ShippingListMethodsForCheckout_Fragment | EventMetadata_ShippingPriceCreated_Fragment | EventMetadata_ShippingPriceDeleted_Fragment | EventMetadata_ShippingPriceUpdated_Fragment | EventMetadata_ShippingZoneCreated_Fragment | EventMetadata_ShippingZoneDeleted_Fragment | EventMetadata_ShippingZoneMetadataUpdated_Fragment | EventMetadata_ShippingZoneUpdated_Fragment | EventMetadata_ShopMetadataUpdated_Fragment | EventMetadata_StaffCreated_Fragment | EventMetadata_StaffDeleted_Fragment | EventMetadata_StaffSetPasswordRequested_Fragment | EventMetadata_StaffUpdated_Fragment | EventMetadata_StoredPaymentMethodDeleteRequested_Fragment | EventMetadata_ThumbnailCreated_Fragment | EventMetadata_TransactionCancelationRequested_Fragment | EventMetadata_TransactionChargeRequested_Fragment | EventMetadata_TransactionInitializeSession_Fragment | EventMetadata_TransactionItemMetadataUpdated_Fragment | EventMetadata_TransactionProcessSession_Fragment | EventMetadata_TransactionRefundRequested_Fragment | EventMetadata_TranslationCreated_Fragment | EventMetadata_TranslationUpdated_Fragment | EventMetadata_VoucherCodeExportCompleted_Fragment | EventMetadata_VoucherCodesCreated_Fragment | EventMetadata_VoucherCodesDeleted_Fragment | EventMetadata_VoucherCreated_Fragment | EventMetadata_VoucherDeleted_Fragment | EventMetadata_VoucherMetadataUpdated_Fragment | EventMetadata_VoucherUpdated_Fragment | EventMetadata_WarehouseCreated_Fragment | EventMetadata_WarehouseDeleted_Fragment | EventMetadata_WarehouseMetadataUpdated_Fragment | EventMetadata_WarehouseUpdated_Fragment;

type SourceObject_Checkout_Fragment = { readonly __typename: 'Checkout', readonly id: string, readonly channel: { readonly id: string, readonly slug: string } };

type SourceObject_Order_Fragment = { readonly __typename: 'Order', readonly id: string, readonly channel: { readonly id: string, readonly slug: string } };

export type SourceObjectFragment = SourceObject_Checkout_Fragment | SourceObject_Order_Fragment;

export type SubscriptionDraftOrderCompleteMutationVariables = Exact<{
  id: Scalars['ID']['input'];
}>;


export type SubscriptionDraftOrderCompleteMutation = { readonly draftOrderComplete?: { readonly order?: { readonly id: string } | null, readonly errors: ReadonlyArray<{ readonly field?: string | null, readonly message?: string | null, readonly code: OrderErrorCode }> } | null };

export type SubscriptionDraftOrderCreateMutationVariables = Exact<{
  input: DraftOrderCreateInput;
}>;


export type SubscriptionDraftOrderCreateMutation = { readonly draftOrderCreate?: { readonly order?: { readonly id: string } | null, readonly errors: ReadonlyArray<{ readonly field?: string | null, readonly message?: string | null, readonly code: OrderErrorCode }> } | null };

export type SubscriptionTransactionCreateMutationVariables = Exact<{
  id: Scalars['ID']['input'];
  transaction: TransactionCreateInput;
}>;


export type SubscriptionTransactionCreateMutation = { readonly transactionCreate?: { readonly transaction?: { readonly id: string } | null, readonly errors: ReadonlyArray<{ readonly field?: string | null, readonly message?: string | null, readonly code: TransactionCreateErrorCode }> } | null };

export type TransactionEventReportWithPaymentDetailsMutationVariables = Exact<{
  transactionId: Scalars['ID']['input'];
  message: Scalars['String']['input'];
  amount: Scalars['PositiveDecimal']['input'];
  pspReference: Scalars['String']['input'];
  time: Scalars['DateTime']['input'];
  type: TransactionEventTypeEnum;
  availableActions?: InputMaybe<ReadonlyArray<TransactionActionEnum> | TransactionActionEnum>;
  externalUrl?: InputMaybe<Scalars['String']['input']>;
  paymentMethodDetails?: InputMaybe<PaymentMethodDetailsInput>;
}>;


export type TransactionEventReportWithPaymentDetailsMutation = { readonly transactionEventReport?: { readonly alreadyProcessed?: boolean | null, readonly errors: ReadonlyArray<{ readonly message?: string | null, readonly code: TransactionEventReportErrorCode }>, readonly transactionEvent?: { readonly id: string } | null } | null };

export type TransactionEventReportMutationVariables = Exact<{
  transactionId: Scalars['ID']['input'];
  message: Scalars['String']['input'];
  amount: Scalars['PositiveDecimal']['input'];
  pspReference: Scalars['String']['input'];
  time: Scalars['DateTime']['input'];
  type: TransactionEventTypeEnum;
  availableActions?: InputMaybe<ReadonlyArray<TransactionActionEnum> | TransactionActionEnum>;
  externalUrl?: InputMaybe<Scalars['String']['input']>;
}>;


export type TransactionEventReportMutation = { readonly transactionEventReport?: { readonly alreadyProcessed?: boolean | null, readonly errors: ReadonlyArray<{ readonly message?: string | null, readonly code: TransactionEventReportErrorCode }>, readonly transactionEvent?: { readonly id: string } | null } | null };

export type FetchChannelsQueryVariables = Exact<{ [key: string]: never; }>;


export type FetchChannelsQuery = { readonly channels?: ReadonlyArray<{ readonly id: string, readonly slug: string }> | null };

export type PaymentGatewayInitializeSessionEventFragment = { readonly version?: string | null, readonly sourceObject: { readonly __typename: 'Checkout', readonly id: string, readonly channel: { readonly id: string, readonly slug: string } } | { readonly __typename: 'Order', readonly id: string, readonly channel: { readonly id: string, readonly slug: string } }, readonly recipient?: { readonly id: string } | null };

export type PaymentGatewayInitializeSessionSubscriptionVariables = Exact<{ [key: string]: never; }>;


export type PaymentGatewayInitializeSessionSubscription = { readonly event?: { readonly version?: string | null, readonly sourceObject: { readonly __typename: 'Checkout', readonly id: string, readonly channel: { readonly id: string, readonly slug: string } } | { readonly __typename: 'Order', readonly id: string, readonly channel: { readonly id: string, readonly slug: string } }, readonly recipient?: { readonly id: string } | null } | {} | null };

export type TransactionCancelationRequestedEventFragment = { readonly version?: string | null, readonly transaction?: { readonly id: string, readonly pspReference: string, readonly checkout?: { readonly id: string, readonly channel: { readonly id: string, readonly slug: string } } | null, readonly order?: { readonly id: string, readonly channel: { readonly id: string, readonly slug: string } } | null } | null, readonly recipient?: { readonly id: string } | null };

export type TransactionCancelationRequestedSubscriptionVariables = Exact<{ [key: string]: never; }>;


export type TransactionCancelationRequestedSubscription = { readonly event?: { readonly version?: string | null, readonly transaction?: { readonly id: string, readonly pspReference: string, readonly checkout?: { readonly id: string, readonly channel: { readonly id: string, readonly slug: string } } | null, readonly order?: { readonly id: string, readonly channel: { readonly id: string, readonly slug: string } } | null } | null, readonly recipient?: { readonly id: string } | null } | {} | null };

export type TransactionChargeRequestedEventFragment = { readonly version?: string | null, readonly action: { readonly amount: number }, readonly transaction?: { readonly id: string, readonly pspReference: string, readonly checkout?: { readonly id: string, readonly channel: { readonly id: string, readonly slug: string } } | null, readonly order?: { readonly id: string, readonly channel: { readonly id: string, readonly slug: string } } | null } | null, readonly recipient?: { readonly id: string } | null };

export type TransactionChargeRequestedSubscriptionVariables = Exact<{ [key: string]: never; }>;


export type TransactionChargeRequestedSubscription = { readonly event?: { readonly version?: string | null, readonly action: { readonly amount: number }, readonly transaction?: { readonly id: string, readonly pspReference: string, readonly checkout?: { readonly id: string, readonly channel: { readonly id: string, readonly slug: string } } | null, readonly order?: { readonly id: string, readonly channel: { readonly id: string, readonly slug: string } } | null } | null, readonly recipient?: { readonly id: string } | null } | {} | null };

export type TransactionInitializeSessionEventFragment = { readonly data?: JSONValue | null, readonly idempotencyKey: string, readonly version?: string | null, readonly action: { readonly amount: number, readonly currency: string, readonly actionType: TransactionFlowStrategyEnum }, readonly transaction: { readonly id: string }, readonly sourceObject: { readonly __typename: 'Checkout', readonly id: string, readonly channel: { readonly id: string, readonly slug: string } } | { readonly __typename: 'Order', readonly id: string, readonly channel: { readonly id: string, readonly slug: string } }, readonly recipient?: { readonly id: string } | null };

export type TransactionInitializeSessionSubscriptionVariables = Exact<{ [key: string]: never; }>;


export type TransactionInitializeSessionSubscription = { readonly event?: { readonly data?: JSONValue | null, readonly idempotencyKey: string, readonly version?: string | null, readonly action: { readonly amount: number, readonly currency: string, readonly actionType: TransactionFlowStrategyEnum }, readonly transaction: { readonly id: string }, readonly sourceObject: { readonly __typename: 'Checkout', readonly id: string, readonly channel: { readonly id: string, readonly slug: string } } | { readonly __typename: 'Order', readonly id: string, readonly channel: { readonly id: string, readonly slug: string } }, readonly recipient?: { readonly id: string } | null } | {} | null };

export type TransactionProcessSessionEventFragment = { readonly version?: string | null, readonly transaction: { readonly pspReference: string }, readonly action: { readonly amount: number, readonly actionType: TransactionFlowStrategyEnum }, readonly sourceObject: { readonly __typename: 'Checkout', readonly id: string, readonly channel: { readonly id: string, readonly slug: string } } | { readonly __typename: 'Order', readonly id: string, readonly channel: { readonly id: string, readonly slug: string } }, readonly recipient?: { readonly id: string } | null };

export type TransactionProcessSessionSubscriptionVariables = Exact<{ [key: string]: never; }>;


export type TransactionProcessSessionSubscription = { readonly event?: { readonly version?: string | null, readonly transaction: { readonly pspReference: string }, readonly action: { readonly amount: number, readonly actionType: TransactionFlowStrategyEnum }, readonly sourceObject: { readonly __typename: 'Checkout', readonly id: string, readonly channel: { readonly id: string, readonly slug: string } } | { readonly __typename: 'Order', readonly id: string, readonly channel: { readonly id: string, readonly slug: string } }, readonly recipient?: { readonly id: string } | null } | {} | null };

export type TransactionRefundRequestedEventFragment = { readonly version?: string | null, readonly action: { readonly amount: number, readonly currency: string }, readonly transaction?: { readonly id: string, readonly pspReference: string, readonly checkout?: { readonly id: string, readonly channel: { readonly id: string, readonly slug: string } } | null, readonly order?: { readonly id: string, readonly channel: { readonly id: string, readonly slug: string } } | null } | null, readonly recipient?: { readonly id: string } | null };

export type TransactionRefundRequestedSubscriptionVariables = Exact<{ [key: string]: never; }>;


export type TransactionRefundRequestedSubscription = { readonly event?: { readonly version?: string | null, readonly action: { readonly amount: number, readonly currency: string }, readonly transaction?: { readonly id: string, readonly pspReference: string, readonly checkout?: { readonly id: string, readonly channel: { readonly id: string, readonly slug: string } } | null, readonly order?: { readonly id: string, readonly channel: { readonly id: string, readonly slug: string } } | null } | null, readonly recipient?: { readonly id: string } | null } | {} | null };

export const UntypedEventMetadataFragmentDoc = gql`
    fragment EventMetadata on Event {
  version
  recipient {
    id
  }
}
    `;
export const UntypedChannelFragmentDoc = gql`
    fragment Channel on Channel {
  id
  slug
}
    `;
export const UntypedSourceObjectFragmentDoc = gql`
    fragment SourceObject on OrderOrCheckout {
  ... on Checkout {
    __typename
    id
    channel {
      ...Channel
    }
  }
  ... on Order {
    __typename
    id
    channel {
      ...Channel
    }
  }
}
    `;
export const UntypedPaymentGatewayInitializeSessionEventFragmentDoc = gql`
    fragment PaymentGatewayInitializeSessionEvent on PaymentGatewayInitializeSession {
  ...EventMetadata
  sourceObject {
    ...SourceObject
  }
}
    `;
export const UntypedTransactionCancelationRequestedEventFragmentDoc = gql`
    fragment TransactionCancelationRequestedEvent on TransactionCancelationRequested {
  ...EventMetadata
  transaction {
    id
    pspReference
    checkout {
      id
      channel {
        ...Channel
      }
    }
    order {
      id
      channel {
        ...Channel
      }
    }
  }
}
    `;
export const UntypedTransactionChargeRequestedEventFragmentDoc = gql`
    fragment TransactionChargeRequestedEvent on TransactionChargeRequested {
  ...EventMetadata
  action {
    amount
  }
  transaction {
    id
    pspReference
    checkout {
      id
      channel {
        ...Channel
      }
    }
    order {
      id
      channel {
        ...Channel
      }
    }
  }
}
    `;
export const UntypedTransactionInitializeSessionEventFragmentDoc = gql`
    fragment TransactionInitializeSessionEvent on TransactionInitializeSession {
  ...EventMetadata
  action {
    amount
    currency
    actionType
  }
  data
  transaction {
    id
  }
  sourceObject {
    ...SourceObject
  }
  idempotencyKey
}
    `;
export const UntypedTransactionProcessSessionEventFragmentDoc = gql`
    fragment TransactionProcessSessionEvent on TransactionProcessSession {
  ...EventMetadata
  transaction {
    pspReference
  }
  action {
    amount
    actionType
  }
  sourceObject {
    ...SourceObject
  }
}
    `;
export const UntypedTransactionRefundRequestedEventFragmentDoc = gql`
    fragment TransactionRefundRequestedEvent on TransactionRefundRequested {
  ...EventMetadata
  action {
    amount
    currency
  }
  transaction {
    id
    pspReference
    checkout {
      id
      channel {
        ...Channel
      }
    }
    order {
      id
      channel {
        ...Channel
      }
    }
  }
}
    `;
export const UntypedSubscriptionDraftOrderCompleteDocument = gql`
    mutation SubscriptionDraftOrderComplete($id: ID!) {
  draftOrderComplete(id: $id) {
    order {
      id
    }
    errors {
      field
      message
      code
    }
  }
}
    `;
export const UntypedSubscriptionDraftOrderCreateDocument = gql`
    mutation SubscriptionDraftOrderCreate($input: DraftOrderCreateInput!) {
  draftOrderCreate(input: $input) {
    order {
      id
    }
    errors {
      field
      message
      code
    }
  }
}
    `;
export const UntypedSubscriptionTransactionCreateDocument = gql`
    mutation SubscriptionTransactionCreate($id: ID!, $transaction: TransactionCreateInput!) {
  transactionCreate(id: $id, transaction: $transaction) {
    transaction {
      id
    }
    errors {
      field
      message
      code
    }
  }
}
    `;
export const UntypedTransactionEventReportWithPaymentDetailsDocument = gql`
    mutation TransactionEventReportWithPaymentDetails($transactionId: ID!, $message: String!, $amount: PositiveDecimal!, $pspReference: String!, $time: DateTime!, $type: TransactionEventTypeEnum!, $availableActions: [TransactionActionEnum!], $externalUrl: String, $paymentMethodDetails: PaymentMethodDetailsInput) {
  transactionEventReport(
    id: $transactionId
    message: $message
    amount: $amount
    pspReference: $pspReference
    time: $time
    type: $type
    availableActions: $availableActions
    externalUrl: $externalUrl
    paymentMethodDetails: $paymentMethodDetails
  ) {
    alreadyProcessed
    errors {
      message
      code
    }
    transactionEvent {
      id
    }
  }
}
    `;
export const UntypedTransactionEventReportDocument = gql`
    mutation TransactionEventReport($transactionId: ID!, $message: String!, $amount: PositiveDecimal!, $pspReference: String!, $time: DateTime!, $type: TransactionEventTypeEnum!, $availableActions: [TransactionActionEnum!], $externalUrl: String) {
  transactionEventReport(
    id: $transactionId
    message: $message
    amount: $amount
    pspReference: $pspReference
    time: $time
    type: $type
    availableActions: $availableActions
    externalUrl: $externalUrl
  ) {
    alreadyProcessed
    errors {
      message
      code
    }
    transactionEvent {
      id
    }
  }
}
    `;
export const UntypedFetchChannelsDocument = gql`
    query FetchChannels {
  channels {
    ...Channel
  }
}
    ${UntypedChannelFragmentDoc}`;
export const UntypedPaymentGatewayInitializeSessionDocument = gql`
    subscription PaymentGatewayInitializeSession {
  event {
    ...PaymentGatewayInitializeSessionEvent
  }
}
    ${UntypedPaymentGatewayInitializeSessionEventFragmentDoc}
${UntypedEventMetadataFragmentDoc}
${UntypedSourceObjectFragmentDoc}
${UntypedChannelFragmentDoc}`;
export const UntypedTransactionCancelationRequestedDocument = gql`
    subscription TransactionCancelationRequested {
  event {
    ...TransactionCancelationRequestedEvent
  }
}
    ${UntypedTransactionCancelationRequestedEventFragmentDoc}
${UntypedEventMetadataFragmentDoc}
${UntypedChannelFragmentDoc}`;
export const UntypedTransactionChargeRequestedDocument = gql`
    subscription TransactionChargeRequested {
  event {
    ...TransactionChargeRequestedEvent
  }
}
    ${UntypedTransactionChargeRequestedEventFragmentDoc}
${UntypedEventMetadataFragmentDoc}
${UntypedChannelFragmentDoc}`;
export const UntypedTransactionInitializeSessionDocument = gql`
    subscription TransactionInitializeSession {
  event {
    ...TransactionInitializeSessionEvent
  }
}
    ${UntypedTransactionInitializeSessionEventFragmentDoc}
${UntypedEventMetadataFragmentDoc}
${UntypedSourceObjectFragmentDoc}
${UntypedChannelFragmentDoc}`;
export const UntypedTransactionProcessSessionDocument = gql`
    subscription TransactionProcessSession {
  event {
    ...TransactionProcessSessionEvent
  }
}
    ${UntypedTransactionProcessSessionEventFragmentDoc}
${UntypedEventMetadataFragmentDoc}
${UntypedSourceObjectFragmentDoc}
${UntypedChannelFragmentDoc}`;
export const UntypedTransactionRefundRequestedDocument = gql`
    subscription TransactionRefundRequested {
  event {
    ...TransactionRefundRequestedEvent
  }
}
    ${UntypedTransactionRefundRequestedEventFragmentDoc}
${UntypedEventMetadataFragmentDoc}
${UntypedChannelFragmentDoc}`;
export const EventMetadataFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"EventMetadata"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Event"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"version"}},{"kind":"Field","name":{"kind":"Name","value":"recipient"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}}]}}]}}]} as unknown as DocumentNode<EventMetadataFragment, unknown>;
export const ChannelFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"Channel"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Channel"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"slug"}}]}}]} as unknown as DocumentNode<ChannelFragment, unknown>;
export const SourceObjectFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"SourceObject"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"OrderOrCheckout"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Checkout"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"__typename"}},{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"channel"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"Channel"}}]}}]}},{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Order"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"__typename"}},{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"channel"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"Channel"}}]}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"Channel"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Channel"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"slug"}}]}}]} as unknown as DocumentNode<SourceObjectFragment, unknown>;
export const PaymentGatewayInitializeSessionEventFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"PaymentGatewayInitializeSessionEvent"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PaymentGatewayInitializeSession"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"EventMetadata"}},{"kind":"Field","name":{"kind":"Name","value":"sourceObject"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"SourceObject"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"Channel"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Channel"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"slug"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"EventMetadata"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Event"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"version"}},{"kind":"Field","name":{"kind":"Name","value":"recipient"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"SourceObject"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"OrderOrCheckout"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Checkout"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"__typename"}},{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"channel"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"Channel"}}]}}]}},{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Order"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"__typename"}},{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"channel"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"Channel"}}]}}]}}]}}]} as unknown as DocumentNode<PaymentGatewayInitializeSessionEventFragment, unknown>;
export const TransactionCancelationRequestedEventFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TransactionCancelationRequestedEvent"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"TransactionCancelationRequested"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"EventMetadata"}},{"kind":"Field","name":{"kind":"Name","value":"transaction"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"pspReference"}},{"kind":"Field","name":{"kind":"Name","value":"checkout"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"channel"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"Channel"}}]}}]}},{"kind":"Field","name":{"kind":"Name","value":"order"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"channel"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"Channel"}}]}}]}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"EventMetadata"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Event"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"version"}},{"kind":"Field","name":{"kind":"Name","value":"recipient"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"Channel"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Channel"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"slug"}}]}}]} as unknown as DocumentNode<TransactionCancelationRequestedEventFragment, unknown>;
export const TransactionChargeRequestedEventFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TransactionChargeRequestedEvent"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"TransactionChargeRequested"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"EventMetadata"}},{"kind":"Field","name":{"kind":"Name","value":"action"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"amount"}}]}},{"kind":"Field","name":{"kind":"Name","value":"transaction"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"pspReference"}},{"kind":"Field","name":{"kind":"Name","value":"checkout"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"channel"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"Channel"}}]}}]}},{"kind":"Field","name":{"kind":"Name","value":"order"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"channel"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"Channel"}}]}}]}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"EventMetadata"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Event"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"version"}},{"kind":"Field","name":{"kind":"Name","value":"recipient"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"Channel"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Channel"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"slug"}}]}}]} as unknown as DocumentNode<TransactionChargeRequestedEventFragment, unknown>;
export const TransactionInitializeSessionEventFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TransactionInitializeSessionEvent"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"TransactionInitializeSession"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"EventMetadata"}},{"kind":"Field","name":{"kind":"Name","value":"action"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"amount"}},{"kind":"Field","name":{"kind":"Name","value":"currency"}},{"kind":"Field","name":{"kind":"Name","value":"actionType"}}]}},{"kind":"Field","name":{"kind":"Name","value":"data"}},{"kind":"Field","name":{"kind":"Name","value":"transaction"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}}]}},{"kind":"Field","name":{"kind":"Name","value":"sourceObject"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"SourceObject"}}]}},{"kind":"Field","name":{"kind":"Name","value":"idempotencyKey"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"Channel"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Channel"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"slug"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"EventMetadata"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Event"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"version"}},{"kind":"Field","name":{"kind":"Name","value":"recipient"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"SourceObject"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"OrderOrCheckout"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Checkout"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"__typename"}},{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"channel"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"Channel"}}]}}]}},{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Order"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"__typename"}},{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"channel"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"Channel"}}]}}]}}]}}]} as unknown as DocumentNode<TransactionInitializeSessionEventFragment, unknown>;
export const TransactionProcessSessionEventFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TransactionProcessSessionEvent"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"TransactionProcessSession"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"EventMetadata"}},{"kind":"Field","name":{"kind":"Name","value":"transaction"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"pspReference"}}]}},{"kind":"Field","name":{"kind":"Name","value":"action"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"amount"}},{"kind":"Field","name":{"kind":"Name","value":"actionType"}}]}},{"kind":"Field","name":{"kind":"Name","value":"sourceObject"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"SourceObject"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"Channel"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Channel"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"slug"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"EventMetadata"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Event"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"version"}},{"kind":"Field","name":{"kind":"Name","value":"recipient"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"SourceObject"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"OrderOrCheckout"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Checkout"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"__typename"}},{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"channel"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"Channel"}}]}}]}},{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Order"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"__typename"}},{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"channel"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"Channel"}}]}}]}}]}}]} as unknown as DocumentNode<TransactionProcessSessionEventFragment, unknown>;
export const TransactionRefundRequestedEventFragmentDoc = {"kind":"Document","definitions":[{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TransactionRefundRequestedEvent"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"TransactionRefundRequested"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"EventMetadata"}},{"kind":"Field","name":{"kind":"Name","value":"action"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"amount"}},{"kind":"Field","name":{"kind":"Name","value":"currency"}}]}},{"kind":"Field","name":{"kind":"Name","value":"transaction"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"pspReference"}},{"kind":"Field","name":{"kind":"Name","value":"checkout"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"channel"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"Channel"}}]}}]}},{"kind":"Field","name":{"kind":"Name","value":"order"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"channel"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"Channel"}}]}}]}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"EventMetadata"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Event"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"version"}},{"kind":"Field","name":{"kind":"Name","value":"recipient"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"Channel"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Channel"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"slug"}}]}}]} as unknown as DocumentNode<TransactionRefundRequestedEventFragment, unknown>;
export const SubscriptionDraftOrderCompleteDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"SubscriptionDraftOrderComplete"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"draftOrderComplete"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"order"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}}]}},{"kind":"Field","name":{"kind":"Name","value":"errors"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"field"}},{"kind":"Field","name":{"kind":"Name","value":"message"}},{"kind":"Field","name":{"kind":"Name","value":"code"}}]}}]}}]}}]} as unknown as DocumentNode<SubscriptionDraftOrderCompleteMutation, SubscriptionDraftOrderCompleteMutationVariables>;
export const SubscriptionDraftOrderCreateDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"SubscriptionDraftOrderCreate"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"DraftOrderCreateInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"draftOrderCreate"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"order"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}}]}},{"kind":"Field","name":{"kind":"Name","value":"errors"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"field"}},{"kind":"Field","name":{"kind":"Name","value":"message"}},{"kind":"Field","name":{"kind":"Name","value":"code"}}]}}]}}]}}]} as unknown as DocumentNode<SubscriptionDraftOrderCreateMutation, SubscriptionDraftOrderCreateMutationVariables>;
export const SubscriptionTransactionCreateDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"SubscriptionTransactionCreate"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"transaction"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"TransactionCreateInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"transactionCreate"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}},{"kind":"Argument","name":{"kind":"Name","value":"transaction"},"value":{"kind":"Variable","name":{"kind":"Name","value":"transaction"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"transaction"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}}]}},{"kind":"Field","name":{"kind":"Name","value":"errors"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"field"}},{"kind":"Field","name":{"kind":"Name","value":"message"}},{"kind":"Field","name":{"kind":"Name","value":"code"}}]}}]}}]}}]} as unknown as DocumentNode<SubscriptionTransactionCreateMutation, SubscriptionTransactionCreateMutationVariables>;
export const TransactionEventReportWithPaymentDetailsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"TransactionEventReportWithPaymentDetails"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"transactionId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"message"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"amount"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"PositiveDecimal"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"pspReference"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"time"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"DateTime"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"type"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"TransactionEventTypeEnum"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"availableActions"}},"type":{"kind":"ListType","type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"TransactionActionEnum"}}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"externalUrl"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"paymentMethodDetails"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"PaymentMethodDetailsInput"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"transactionEventReport"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"transactionId"}}},{"kind":"Argument","name":{"kind":"Name","value":"message"},"value":{"kind":"Variable","name":{"kind":"Name","value":"message"}}},{"kind":"Argument","name":{"kind":"Name","value":"amount"},"value":{"kind":"Variable","name":{"kind":"Name","value":"amount"}}},{"kind":"Argument","name":{"kind":"Name","value":"pspReference"},"value":{"kind":"Variable","name":{"kind":"Name","value":"pspReference"}}},{"kind":"Argument","name":{"kind":"Name","value":"time"},"value":{"kind":"Variable","name":{"kind":"Name","value":"time"}}},{"kind":"Argument","name":{"kind":"Name","value":"type"},"value":{"kind":"Variable","name":{"kind":"Name","value":"type"}}},{"kind":"Argument","name":{"kind":"Name","value":"availableActions"},"value":{"kind":"Variable","name":{"kind":"Name","value":"availableActions"}}},{"kind":"Argument","name":{"kind":"Name","value":"externalUrl"},"value":{"kind":"Variable","name":{"kind":"Name","value":"externalUrl"}}},{"kind":"Argument","name":{"kind":"Name","value":"paymentMethodDetails"},"value":{"kind":"Variable","name":{"kind":"Name","value":"paymentMethodDetails"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"alreadyProcessed"}},{"kind":"Field","name":{"kind":"Name","value":"errors"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"message"}},{"kind":"Field","name":{"kind":"Name","value":"code"}}]}},{"kind":"Field","name":{"kind":"Name","value":"transactionEvent"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}}]}}]}}]}}]} as unknown as DocumentNode<TransactionEventReportWithPaymentDetailsMutation, TransactionEventReportWithPaymentDetailsMutationVariables>;
export const TransactionEventReportDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"TransactionEventReport"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"transactionId"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"message"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"amount"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"PositiveDecimal"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"pspReference"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"time"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"DateTime"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"type"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"TransactionEventTypeEnum"}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"availableActions"}},"type":{"kind":"ListType","type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"TransactionActionEnum"}}}}},{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"externalUrl"}},"type":{"kind":"NamedType","name":{"kind":"Name","value":"String"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"transactionEventReport"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"transactionId"}}},{"kind":"Argument","name":{"kind":"Name","value":"message"},"value":{"kind":"Variable","name":{"kind":"Name","value":"message"}}},{"kind":"Argument","name":{"kind":"Name","value":"amount"},"value":{"kind":"Variable","name":{"kind":"Name","value":"amount"}}},{"kind":"Argument","name":{"kind":"Name","value":"pspReference"},"value":{"kind":"Variable","name":{"kind":"Name","value":"pspReference"}}},{"kind":"Argument","name":{"kind":"Name","value":"time"},"value":{"kind":"Variable","name":{"kind":"Name","value":"time"}}},{"kind":"Argument","name":{"kind":"Name","value":"type"},"value":{"kind":"Variable","name":{"kind":"Name","value":"type"}}},{"kind":"Argument","name":{"kind":"Name","value":"availableActions"},"value":{"kind":"Variable","name":{"kind":"Name","value":"availableActions"}}},{"kind":"Argument","name":{"kind":"Name","value":"externalUrl"},"value":{"kind":"Variable","name":{"kind":"Name","value":"externalUrl"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"alreadyProcessed"}},{"kind":"Field","name":{"kind":"Name","value":"errors"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"message"}},{"kind":"Field","name":{"kind":"Name","value":"code"}}]}},{"kind":"Field","name":{"kind":"Name","value":"transactionEvent"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}}]}}]}}]}}]} as unknown as DocumentNode<TransactionEventReportMutation, TransactionEventReportMutationVariables>;
export const FetchChannelsDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"FetchChannels"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"channels"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"Channel"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"Channel"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Channel"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"slug"}}]}}]} as unknown as DocumentNode<FetchChannelsQuery, FetchChannelsQueryVariables>;
export const PaymentGatewayInitializeSessionDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"subscription","name":{"kind":"Name","value":"PaymentGatewayInitializeSession"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"event"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"PaymentGatewayInitializeSessionEvent"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"EventMetadata"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Event"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"version"}},{"kind":"Field","name":{"kind":"Name","value":"recipient"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"Channel"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Channel"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"slug"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"SourceObject"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"OrderOrCheckout"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Checkout"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"__typename"}},{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"channel"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"Channel"}}]}}]}},{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Order"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"__typename"}},{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"channel"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"Channel"}}]}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"PaymentGatewayInitializeSessionEvent"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"PaymentGatewayInitializeSession"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"EventMetadata"}},{"kind":"Field","name":{"kind":"Name","value":"sourceObject"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"SourceObject"}}]}}]}}]} as unknown as DocumentNode<PaymentGatewayInitializeSessionSubscription, PaymentGatewayInitializeSessionSubscriptionVariables>;
export const TransactionCancelationRequestedDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"subscription","name":{"kind":"Name","value":"TransactionCancelationRequested"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"event"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"TransactionCancelationRequestedEvent"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"EventMetadata"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Event"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"version"}},{"kind":"Field","name":{"kind":"Name","value":"recipient"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"Channel"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Channel"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"slug"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TransactionCancelationRequestedEvent"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"TransactionCancelationRequested"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"EventMetadata"}},{"kind":"Field","name":{"kind":"Name","value":"transaction"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"pspReference"}},{"kind":"Field","name":{"kind":"Name","value":"checkout"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"channel"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"Channel"}}]}}]}},{"kind":"Field","name":{"kind":"Name","value":"order"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"channel"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"Channel"}}]}}]}}]}}]}}]} as unknown as DocumentNode<TransactionCancelationRequestedSubscription, TransactionCancelationRequestedSubscriptionVariables>;
export const TransactionChargeRequestedDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"subscription","name":{"kind":"Name","value":"TransactionChargeRequested"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"event"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"TransactionChargeRequestedEvent"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"EventMetadata"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Event"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"version"}},{"kind":"Field","name":{"kind":"Name","value":"recipient"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"Channel"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Channel"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"slug"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TransactionChargeRequestedEvent"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"TransactionChargeRequested"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"EventMetadata"}},{"kind":"Field","name":{"kind":"Name","value":"action"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"amount"}}]}},{"kind":"Field","name":{"kind":"Name","value":"transaction"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"pspReference"}},{"kind":"Field","name":{"kind":"Name","value":"checkout"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"channel"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"Channel"}}]}}]}},{"kind":"Field","name":{"kind":"Name","value":"order"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"channel"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"Channel"}}]}}]}}]}}]}}]} as unknown as DocumentNode<TransactionChargeRequestedSubscription, TransactionChargeRequestedSubscriptionVariables>;
export const TransactionInitializeSessionDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"subscription","name":{"kind":"Name","value":"TransactionInitializeSession"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"event"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"TransactionInitializeSessionEvent"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"EventMetadata"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Event"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"version"}},{"kind":"Field","name":{"kind":"Name","value":"recipient"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"Channel"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Channel"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"slug"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"SourceObject"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"OrderOrCheckout"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Checkout"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"__typename"}},{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"channel"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"Channel"}}]}}]}},{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Order"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"__typename"}},{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"channel"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"Channel"}}]}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TransactionInitializeSessionEvent"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"TransactionInitializeSession"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"EventMetadata"}},{"kind":"Field","name":{"kind":"Name","value":"action"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"amount"}},{"kind":"Field","name":{"kind":"Name","value":"currency"}},{"kind":"Field","name":{"kind":"Name","value":"actionType"}}]}},{"kind":"Field","name":{"kind":"Name","value":"data"}},{"kind":"Field","name":{"kind":"Name","value":"transaction"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}}]}},{"kind":"Field","name":{"kind":"Name","value":"sourceObject"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"SourceObject"}}]}},{"kind":"Field","name":{"kind":"Name","value":"idempotencyKey"}}]}}]} as unknown as DocumentNode<TransactionInitializeSessionSubscription, TransactionInitializeSessionSubscriptionVariables>;
export const TransactionProcessSessionDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"subscription","name":{"kind":"Name","value":"TransactionProcessSession"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"event"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"TransactionProcessSessionEvent"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"EventMetadata"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Event"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"version"}},{"kind":"Field","name":{"kind":"Name","value":"recipient"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"Channel"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Channel"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"slug"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"SourceObject"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"OrderOrCheckout"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Checkout"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"__typename"}},{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"channel"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"Channel"}}]}}]}},{"kind":"InlineFragment","typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Order"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"__typename"}},{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"channel"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"Channel"}}]}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TransactionProcessSessionEvent"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"TransactionProcessSession"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"EventMetadata"}},{"kind":"Field","name":{"kind":"Name","value":"transaction"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"pspReference"}}]}},{"kind":"Field","name":{"kind":"Name","value":"action"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"amount"}},{"kind":"Field","name":{"kind":"Name","value":"actionType"}}]}},{"kind":"Field","name":{"kind":"Name","value":"sourceObject"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"SourceObject"}}]}}]}}]} as unknown as DocumentNode<TransactionProcessSessionSubscription, TransactionProcessSessionSubscriptionVariables>;
export const TransactionRefundRequestedDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"subscription","name":{"kind":"Name","value":"TransactionRefundRequested"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"event"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"TransactionRefundRequestedEvent"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"EventMetadata"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Event"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"version"}},{"kind":"Field","name":{"kind":"Name","value":"recipient"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}}]}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"Channel"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"Channel"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"slug"}}]}},{"kind":"FragmentDefinition","name":{"kind":"Name","value":"TransactionRefundRequestedEvent"},"typeCondition":{"kind":"NamedType","name":{"kind":"Name","value":"TransactionRefundRequested"}},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"EventMetadata"}},{"kind":"Field","name":{"kind":"Name","value":"action"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"amount"}},{"kind":"Field","name":{"kind":"Name","value":"currency"}}]}},{"kind":"Field","name":{"kind":"Name","value":"transaction"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"pspReference"}},{"kind":"Field","name":{"kind":"Name","value":"checkout"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"channel"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"Channel"}}]}}]}},{"kind":"Field","name":{"kind":"Name","value":"order"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"channel"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"FragmentSpread","name":{"kind":"Name","value":"Channel"}}]}}]}}]}}]}}]} as unknown as DocumentNode<TransactionRefundRequestedSubscription, TransactionRefundRequestedSubscriptionVariables>;