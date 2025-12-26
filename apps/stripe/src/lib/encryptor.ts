import { Encryptor as BaseEncryptor, IEncryptor } from "@saleor/apps-shared/encryptor";

import { env } from "@/lib/env";

export class Encryptor implements IEncryptor {
  private encryptor: BaseEncryptor;

  constructor() {
    this.encryptor = new BaseEncryptor(env.SECRET_KEY);
  }

  encrypt(text: string): string {
    return this.encryptor.encrypt(text);
  }

  decrypt(text: string): string {
    return this.encryptor.decrypt(text);
  }
}
