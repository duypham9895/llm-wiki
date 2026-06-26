"""recent_views table

Revision ID: d55aee795405
Revises: b71287ba6af3
Create Date: 2026-06-26 12:00:00.000000
"""
from alembic import op
import sqlalchemy as sa


revision = 'd55aee795405'
down_revision = 'b71287ba6af3'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'recent_views',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('user_id', sa.UUID(), nullable=False),
        sa.Column('prd_id', sa.String(), nullable=False),
        sa.Column('viewed_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('user_id', 'prd_id', name='uq_recent_views_user_prd'),
    )
    op.create_index('ix_recent_views_user_viewed', 'recent_views', ['user_id', 'viewed_at'], unique=False)


def downgrade() -> None:
    op.drop_index('ix_recent_views_user_viewed', table_name='recent_views')
    op.drop_table('recent_views')