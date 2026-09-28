import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { AuthRequest, SessionGuard } from './common';
import { AiService } from './ai.service';

@Controller('api/v1/ai')
@UseGuards(SessionGuard)
export class AiController {
  constructor(private ai: AiService) {}
  @Get('status') status() { return this.ai.status(); }
  @Get('conversations') list(@Req() r: AuthRequest) { return this.ai.list(r.actor); }
  @Get('conversations/:id') get(@Req() r: AuthRequest, @Param('id') id: string) { return this.ai.get(r.actor, id); }
  @Delete('conversations/:id') remove(@Req() r: AuthRequest, @Param('id') id: string) { return this.ai.remove(r.actor, id); }
  @Get('follow-up-drafts/:type/:id') latestFollowUpDraft(@Req() r: AuthRequest, @Param('type') type: string, @Param('id') id: string) { return this.ai.latestFollowUpDraft(r.actor, type, id); }
  @Post('follow-up-drafts') generateFollowUpDraft(@Req() r: AuthRequest, @Body() body: unknown) { return this.ai.generateFollowUpDraft(r.actor, body); }
  @Post('chat') chat(@Req() r: AuthRequest, @Body() body: unknown) { return this.ai.chat(r.actor, body); }
}
