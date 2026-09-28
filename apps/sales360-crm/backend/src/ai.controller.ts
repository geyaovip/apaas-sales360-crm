import { Body, Controller, Delete, Get, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import { AuthRequest, SessionGuard } from './common';
import { AiService } from './ai.service';

@Controller('api/v1/ai')
@UseGuards(SessionGuard)
export class AiController {
  constructor(private ai: AiService) {}
  @Get('status') status(@Req() r: AuthRequest) { return this.ai.status(r.actor); }
  @Get('settings') settings(@Req() r: AuthRequest) { return this.ai.settings(r.actor); }
  @Put('settings') saveSettings(@Req() r: AuthRequest, @Body() body: unknown) { return this.ai.saveSettings(r.actor, body); }
  @Post('settings/test') testSettings(@Req() r: AuthRequest, @Body() body: unknown) { return this.ai.testSettings(r.actor, body); }
  @Delete('settings') clearSettings(@Req() r: AuthRequest) { return this.ai.clearSettings(r.actor); }
  @Get('conversations') list(@Req() r: AuthRequest) { return this.ai.list(r.actor); }
  @Get('conversations/:id') get(@Req() r: AuthRequest, @Param('id') id: string) { return this.ai.get(r.actor, id); }
  @Delete('conversations/:id') remove(@Req() r: AuthRequest, @Param('id') id: string) { return this.ai.remove(r.actor, id); }
  @Get('follow-up-drafts/:type/:id') latestFollowUpDraft(@Req() r: AuthRequest, @Param('type') type: string, @Param('id') id: string) { return this.ai.latestFollowUpDraft(r.actor, type, id); }
  @Post('follow-up-drafts') generateFollowUpDraft(@Req() r: AuthRequest, @Body() body: unknown) { return this.ai.generateFollowUpDraft(r.actor, body); }
  @Post('chat') chat(@Req() r: AuthRequest, @Body() body: unknown) { return this.ai.chat(r.actor, body); }
}
