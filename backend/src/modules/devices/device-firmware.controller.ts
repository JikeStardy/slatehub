import { Body, Controller, Post, Put, UseGuards } from '@nestjs/common';
import { MacAddress, type DeviceStateT, type RegisterDeviceResponseT } from 'shared';
import { CurrentDevice, Public } from '../../common/nest/decorators/auth-context.decorators';
import { DeviceAuthGuard } from '../../common/nest/guards/device-auth.guard';
import type { DeviceContext } from '../../common/nest/auth-context';
import { RateLimit } from '../../common/rate-limit/rate-limit-guard';
import { DeviceFirmwareService } from './device-firmware.service';
import { GroupsService } from '../groups/groups.service';
import { RegisterDeviceDto } from './dto/register-device.dto';
import { PollDto } from './dto/poll.dto';
import { SelectGroupByDeviceDto } from './dto/select-group.dto';
import { deviceRegisterRateLimit } from './device-rate-limits';

@Controller()
export class DeviceFirmwareController {
  constructor(
    private readonly devices: DeviceFirmwareService,
    private readonly groups: GroupsService
  ) {}

  // ── register / reset（无鉴权）────────────────────────────
  // 同 mac 二次进来一律走 reset 路径（清 owner、清相册、轮换 secret + pair_code），
  // 实现「物理重置即转移」语义。固件那侧只在 NVS 没 device_secret 时调用此端点。
  @Public()
  @RateLimit(deviceRegisterRateLimit)
  @Post('devices')
  async register(@Body() body: RegisterDeviceDto): Promise<RegisterDeviceResponseT> {
    const r = await this.devices.registerOrReset(body);
    return {
      id: r.deviceId,
      mac: MacAddress.parse(body.mac),
      device_secret: r.deviceSecret,
      pair_code: r.pairCode,
      reclaimed: r.reclaimed,
      server_time: r.serverTime,
    };
  }

  // ── 以下 /devices/current/* 都要 Authorization: Bearer <device_secret> ───
  @Public()
  @UseGuards(DeviceAuthGuard)
  @Post('devices/current/poll')
  async poll(@CurrentDevice() dev: DeviceContext, @Body() body: PollDto): Promise<DeviceStateT> {
    return this.devices.poll(dev.deviceId, body.telemetry);
  }

  @Public()
  @UseGuards(DeviceAuthGuard)
  @Put('devices/current/group')
  async selectGroup(
    @CurrentDevice() dev: DeviceContext,
    @Body() body: SelectGroupByDeviceDto
  ): Promise<DeviceStateT> {
    await this.groups.setDeviceGroup(dev.deviceId, body.id);
    return this.devices.buildState(dev.deviceId);
  }

  @Public()
  @UseGuards(DeviceAuthGuard)
  @Post('devices/current/group/next')
  async cycleNext(@CurrentDevice() dev: DeviceContext): Promise<DeviceStateT> {
    const result = await this.groups.cycleDeviceGroup(dev.deviceId, 'next');
    return this.devices.buildState(dev.deviceId, { group: result });
  }

  @Public()
  @UseGuards(DeviceAuthGuard)
  @Post('devices/current/group/prev')
  async cyclePrev(@CurrentDevice() dev: DeviceContext): Promise<DeviceStateT> {
    const result = await this.groups.cycleDeviceGroup(dev.deviceId, 'prev');
    return this.devices.buildState(dev.deviceId, { group: result });
  }
}
