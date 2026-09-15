import { Module } from '@nestjs/common';
import { BlobModule } from '../../infra/blob/blob.module';
import { GroupsModule } from '../groups/groups.module';
import { AiModule } from '../ai/ai.module';
import { HotListModule } from '../hot-list/hot-list.module';
import { RenderingModule } from '../rendering/rendering.module';
import { DynamicRenderingModule } from './rendering/dynamic-rendering.module';
import { DynamicAudioModule } from './audio/dynamic-audio.module';
import { DynamicContentRegistry } from './dynamic-content-registry';
import { DailyCalendarProvider } from './providers/daily-calendar.provider';
import { MonthCalendarProvider } from './providers/month-calendar.provider';
import { WeatherProvider } from './providers/weather.provider';
import { QweatherConfig } from './providers/qweather.config';
import { HistoryTodayProvider } from './providers/history-today.provider';
import { WeatherAlertProvider } from './providers/weather-alert.provider';
import { EarthquakeReportProvider } from './providers/earthquake-report.provider';
import { DashboardProvider } from './providers/dashboard.provider';
import { FontTestProvider } from './providers/font-test.provider';
import { CalendarDataService } from './calendar-data.service';
import { DynamicContentRendererService } from './dynamic-content-renderer.service';
import { DynamicContentService } from './dynamic-content.service';
import { DynamicContentSchedulerService } from './dynamic-content-scheduler.service';
import { WeatherCityController } from './weather-city.controller';
import { DashboardIngestController } from './ingest/dashboard-ingest.controller';
import { IngestPayloadSizeGuard } from './ingest/ingest-payload-size.guard';
import { IngestPayloadSizePipe } from './ingest/ingest-payload-size.pipe';
import { DynamicPreviewController } from './dynamic-preview.controller';

/**
 * 动态内容模板与渲染业务模块。
 *
 * 创建/修改/预览/data push / refresh 的动态内容生命周期由 DynamicContentService 承担；
 * contents module 只负责把通用内容 API 转发进来。
 *
 * 暴露 DynamicContentRegistry、DynamicContentRendererService 与 DynamicContentService 给 contents module 使用。
 */
@Module({
  imports: [
    BlobModule,
    GroupsModule,
    AiModule,
    HotListModule,
    RenderingModule,
    DynamicRenderingModule,
    DynamicAudioModule,
  ],
  controllers: [WeatherCityController, DashboardIngestController, DynamicPreviewController],
  providers: [
    DynamicContentRegistry,
    CalendarDataService,
    DynamicContentRendererService,
    DynamicContentService,
    QweatherConfig,
    DailyCalendarProvider,
    MonthCalendarProvider,
    WeatherProvider,
    HistoryTodayProvider,
    WeatherAlertProvider,
    EarthquakeReportProvider,
    DashboardProvider,
    FontTestProvider,
    DynamicContentSchedulerService,
    IngestPayloadSizeGuard,
    IngestPayloadSizePipe,
  ],
  exports: [
    DynamicContentRegistry,
    DynamicContentRendererService,
    DynamicContentService,
    CalendarDataService,
  ],
})
export class DynamicContentModule {}
