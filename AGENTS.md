<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Commercial funnel rules
- Business rules for the Stefanello funnel live in DB triggers keyed by `boards.board_key` and `board_stages.stage_key` (never by display names); boards without a `board_key` are untouched so existing AI/pipeline flows keep working.
- Automated stage moves go through `private.stef_move_deal`, which sets `app.deal_stage_transition_context` required by the stage-transition guard.
