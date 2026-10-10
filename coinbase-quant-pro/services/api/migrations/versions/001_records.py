"""Append-only research snapshots; full normalized data warehouse is future work."""

from alembic import op
import sqlalchemy as sa

revision = "001"
down_revision = None


def upgrade():
    op.create_table(
        "research_records",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("kind", sa.String(32), nullable=False),
        sa.Column("product", sa.String(48), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("payload", sa.JSON, nullable=False),
    )
    op.create_index("ix_research_records_kind", "research_records", ["kind"])
    op.create_index("ix_research_records_product", "research_records", ["product"])


def downgrade():
    op.drop_table("research_records")
