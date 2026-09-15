import { RegisterDeviceRequest, type RegisterDeviceRequestT } from 'shared';

export class RegisterDeviceDto implements RegisterDeviceRequestT {
  static readonly schema = RegisterDeviceRequest;
  declare mac: string;
  declare board_id: RegisterDeviceRequestT['board_id'];
  declare protocol_version: RegisterDeviceRequestT['protocol_version'];
  declare fw_version: RegisterDeviceRequestT['fw_version'];
}
