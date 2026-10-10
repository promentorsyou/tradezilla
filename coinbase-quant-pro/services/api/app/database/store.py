import os
import uuid
from datetime import UTC, datetime

from sqlalchemy import JSON, DateTime, String, create_engine, select
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column


class Base(DeclarativeBase):
    pass


class Record(Base):
    __tablename__ = "research_records"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    kind: Mapped[str] = mapped_column(String(32), index=True)
    product: Mapped[str] = mapped_column(String(48), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    payload: Mapped[dict] = mapped_column(JSON)


engine = create_engine(os.getenv("DATABASE_URL", "sqlite:///quant.db"))


def append(kind, product, payload, record_id=None):
    identifier = record_id or str(uuid.uuid4())
    with Session(engine) as session:
        session.add(
            Record(
                id=identifier,
                kind=kind,
                product=product,
                created_at=datetime.now(UTC),
                payload=payload,
            )
        )
        session.commit()
    return identifier


def history(kind, product=None, limit=50):
    query = select(Record).where(Record.kind == kind)
    if product:
        query = query.where(Record.product == product)
    with Session(engine) as session:
        return [
            {"id": r.id, "created_at": r.created_at.isoformat(), "product": r.product, **r.payload}
            for r in session.scalars(query.order_by(Record.created_at.desc()).limit(limit))
        ]
