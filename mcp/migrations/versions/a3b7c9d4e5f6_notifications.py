"""notifications table

Revision ID: a3b7c9d4e5f6
Revises: d55aee795405
Create Date: 2026-06-26 12:00:00.000000
"""
from alembic import op
import sqlalchemy as sa


revision = 'a3b7c9d4e5f6'
down_revision = 'd55aee795405'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'notifications',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('user_id', sa.UUID(), nullable=False),
        sa.Column('kind', sa.String(), nullable=False),
        sa.Column('title', sa.String(), nullable=False),
        sa.Column('body', sa.String(), nullable=False, server_default=''),
        sa.Column('link', sa.String(), nullable=True),
        sa.Column('read_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.CheckConstraint(
            "kind IN ('sync_failed','prd_added','prd_edited','system')",
            name='ck_notifications_kind',
        ),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(
        'ix_notifications_user_read_created',
        'notifications',
        ['user_id', 'read_at', 'created_at'],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index('ix_notifications_user_read_created', table_name='notifications')
    op.drop_table('notifications')